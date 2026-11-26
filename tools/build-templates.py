#!/usr/bin/env python3
"""Build templates/samsung-appliances.json from Home Assistant's SmartThings test fixtures.

The fixtures (tests/components/smartthings/fixtures in https://github.com/home-assistant/core,
Apache-2.0) are real device dumps from Samsung appliances: component / capability lists and
attribute values. We keep only the standard capability lists and their sample attribute values.

Usage:
  git clone --depth 1 --filter=blob:none --sparse https://github.com/home-assistant/core ha-core
  git -C ha-core sparse-checkout set tests/components/smartthings
  python3 tools/build-templates.py ha-core
"""
import json, os, re, subprocess, sys

ha = sys.argv[1] if len(sys.argv) > 1 else 'ha-core'
fx = os.path.join(ha, 'tests/components/smartthings/fixtures')
commit = subprocess.run(['git', '-C', ha, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()

# Only standard (namespace-less) capabilities are kept: Samsung-specific ones (custom.*, samsungce.*,
# hca.*, sec.* ...) are left out on purpose, and so are OCF/cloud plumbing capabilities that mean
# nothing on a virtual device.
PLUMBING = {'ocf', 'execute', 'logTrigger', 'demandResponseLoadControl'}
MIN_CAPABILITIES = 4  # skip models that end up with too few standard capabilities to be useful
MAX_ATTR_BYTES = 4000  # drop huge attribute values (e.g. cycle tables) from the sample state

# fixture -> (display name, icon)
MODELS = {
    'da_wm_wm_01011': ('Washer', '🧺'), 'da_wm_wm_000001': ('Washer (older model)', '🧺'),
    'da_wm_wm_100002': ('Washer (two-unit)', '🧺'),
    'da_wm_wd_01011': ('Dryer', '🌀'), 'da_wm_wd_000001': ('Dryer (older model)', '🌀'),
    'da_wm_dw_01011': ('Dishwasher', '🍽️'), 'da_wm_dw_000001': ('Dishwasher (older model)', '🍽️'),
    'da_wm_sc_000001': ('Steam closet (AirDresser)', '👔'), 'da_wm_mf_01001': ('Microfiber filter', '🧺'),
    'da_ac_rac_01001': ('Air conditioner', '❄️'), 'da_ac_rac_000001': ('Air conditioner (multi-unit)', '❄️'),
    'da_ac_rac_000003': ('Air conditioner (older model)', '❄️'), 'da_ac_rac_100001': ('Air conditioner (minimal)', '❄️'),
    'da_ac_cac_01001': ('Cassette air conditioner', '❄️'), 'da_ac_ehs_01001': ('Heat pump (EHS)', '♨️'),
    'da_sac_ehs_000001_sub': ('Heat pump indoor unit', '♨️'), 'da_sac_ehs_000002_sub': ('Heat pump, two indoor units', '♨️'),
    'da_ac_air_01011': ('Air purifier', '🍃'), 'da_ac_air_000001': ('Air purifier (older model)', '🍃'),
    'da_ac_airsensor_01001': ('Air quality sensor', '🌫️'),
    'da_ref_normal_01011': ('Refrigerator', '🧊'), 'da_ref_normal_01011_onedoor': ('Refrigerator (one-door zone)', '🧊'),
    'da_ref_normal_000001': ('Refrigerator (older model)', '🧊'), 'da_ref_normal_01001': ('Refrigerator (with scale / camera)', '🧊'),
    'da_ref_normal_100001': ('Refrigerator (minimal)', '🧊'),
    'da_rvc_map_01011': ('Robot vacuum (with map / station)', '🤖'), 'da_rvc_normal_000001': ('Robot vacuum', '🤖'),
    'da_vc_stick_01001': ('Stick vacuum', '🧹'),
    'da_ks_oven_0107x': ('Oven', '🔥'), 'da_ks_oven_01061': ('Oven (older model)', '🔥'),
    'da_ks_walloven_0107x': ('Wall oven (two cavities)', '🔥'), 'da_ks_range_0101x': ('Range', '🔥'),
    'da_ks_microwave_0101x': ('Microwave', '♨️'), 'da_ks_cooktop_31001': ('Cooktop (6 burners)', '🍳'),
    'da_ks_cooktop_000001': ('Cooktop', '🍳'), 'da_ks_hood_01001': ('Range hood', '💨'),
    'vd_stv_2017_k': ('TV', '📺'), 'hw_q80r_soundbar': ('Soundbar', '🔊'),
}

# Matter Device Library chapter used as the GUI category (same list as tools/build-iot-templates.py).
def category(fixture):
    if fixture.startswith(('da_ac_ehs', 'da_sac_ehs', 'da_ac_air_')):
        return 'HVAC'
    if fixture.startswith('da_ac_airsensor'):
        return 'Sensors'
    if fixture.startswith(('da_rvc', 'da_vc')):
        return 'Robotic'
    if fixture.startswith(('vd_', 'hw_')):
        return 'Media'
    return 'Appliances'  # washers, dryers, dishwashers, air conditioners, refrigerators, cooking


def standard(cap_id):
    return '.' not in cap_id


def sanitize_profile_name(name):
    # SmartThings virtualdevices:create rejects '/', '&', ',' in deviceProfile.name with HTTP 422;
    # brackets and other symbols are dropped too, to be safe.
    s = name.replace('&', ' and ').replace('/', '-')
    s = re.sub(r'[^A-Za-z0-9 _-]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip() or 'Virtual Profile'

out = []
for fixture, (name, icon) in MODELS.items():
    dev = json.load(open(f'{fx}/devices/{fixture}.json'))['items'][0]
    status = json.load(open(f'{fx}/device_status/{fixture}.json'))['components']
    comps, sample, skipped = [], {}, 0
    for c in dev['components']:
        caps = [x for x in c['capabilities'] if x['id'] not in PLUMBING]
        std = [x for x in caps if standard(x['id'])]
        skipped += len(caps) - len(std)
        cat = [{'name': k['name']} for k in c.get('categories', [])][:1]
        if std:
            comps.append({'id': c['id'], 'capabilities': [{'id': x['id'], 'version': x.get('version', 1)} for x in std],
                          **({'categories': cat} if cat else {})})
        for x in std:
            attrs = status.get(c['id'], {}).get(x['id'], {})
            keep = {}
            for a, v in attrs.items():
                if not isinstance(v, dict) or v.get('value') is None:
                    continue
                if len(json.dumps(v['value'])) > MAX_ATTR_BYTES:
                    continue
                keep[a] = {'value': v['value'], **({'unit': v['unit']} if v.get('unit') else {})}
            if keep:
                sample.setdefault(c['id'], {})[x['id']] = keep
    n_std = sum(len(c['capabilities']) for c in comps)
    if n_std < MIN_CAPABILITIES:
        print('skip', fixture, n_std, 'standard capabilities')
        continue
    out.append({
        'id': fixture, 'name': name, 'icon': icon, 'category': category(fixture),
        'description': f"{dev.get('deviceTypeName')} · {dev.get('presentationId')} · {n_std} standard capabilities",
        'source': {'fixture': fixture, 'presentationId': dev.get('presentationId'), 'deviceTypeName': dev.get('deviceTypeName')},
        'deviceProfile': {'name': sanitize_profile_name(f'Virtual {name}')[:40].strip(), 'components': comps},
        'sampleState': sample,
    })

os.makedirs('templates', exist_ok=True)
json.dump({'generatedFrom': {'repository': 'https://github.com/home-assistant/core', 'commit': commit,
                             'path': 'tests/components/smartthings/fixtures', 'license': 'Apache-2.0'},
           'templates': out}, open('templates/samsung-appliances.json', 'w'), ensure_ascii=False, indent=1)
print(len(out), 'templates, commit', commit)
