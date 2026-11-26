#!/usr/bin/env python3
"""Build templates/matter-devices.json from SmartThings' official Matter Edge drivers.

SmartThings turns a commissioned Matter device into a SmartThings device whose device profile is
picked by its Matter Edge driver. Those profiles live in
https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers (drivers/SmartThings/matter-*/profiles,
Apache-2.0). We copy the standard capability lists of the most common profiles so that a *virtual*
device looks the same to apps, automations and the API as a real Matter device of that type.
The virtual device does not speak Matter (no commissioning, clusters or endpoints).

Usage:
  git clone --depth 1 --filter=blob:none --sparse https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers ste
  git -C ste sparse-checkout set --no-cone '/drivers/SmartThings/matter-*/profiles/*'
  python3 tools/build-matter-templates.py ste

Requires PyYAML (pip install pyyaml).
"""
import json, os, re, subprocess, sys

import yaml

root = sys.argv[1] if len(sys.argv) > 1 else 'ste'
drivers = os.path.join(root, 'drivers', 'SmartThings')
commit = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()

# Capabilities that mean nothing on a virtual device: firmware plumbing, command-only "stateless" step
# capabilities, and the camera streaming / storage capabilities (a virtual camera has no video).
DROP = {
    'firmwareUpdate', 'batteryLevel',
    'webrtc', 'videoCapture2', 'videoStreamSettings', 'imageCapture', 'localMediaStorage',
    'zoneManagement', 'cameraViewportSettings', 'audioRecording',
}

def keep(cap_id):
    # Standard (namespace-less) capabilities only: vendor ones such as vision.* are left out.
    return '.' not in cap_id and cap_id not in DROP and not cap_id.startswith('stateless')

# Default Matter cluster behind each SmartThings capability (what the Matter driver maps from).
CLUSTER = {
    'switch': 'On/Off', 'switchLevel': 'Level Control', 'colorTemperature': 'Color Control (color temperature)',
    'colorControl': 'Color Control (hue / saturation)', 'button': 'Switch', 'battery': 'Power Source',
    'contactSensor': 'Boolean State', 'motionSensor': 'Occupancy Sensing', 'waterSensor': 'Boolean State',
    'temperatureMeasurement': 'Temperature Measurement', 'relativeHumidityMeasurement': 'Relative Humidity Measurement',
    'lock': 'Door Lock', 'lockAlarm': 'Door Lock (alarm events)', 'remoteControlStatus': 'Door Lock (operating mode)',
    'thermostatMode': 'Thermostat', 'thermostatHeatingSetpoint': 'Thermostat', 'thermostatCoolingSetpoint': 'Thermostat',
    'thermostatOperatingState': 'Thermostat', 'windowShade': 'Window Covering', 'windowShadeLevel': 'Window Covering',
    'windowShadePreset': 'Window Covering (preset position)', 'windowShadeTiltLevel': 'Window Covering (tilt)',
    'mediaPlayback': 'Media Playback', 'mediaTrackControl': 'Media Playback (next / previous)', 'keypadInput': 'Keypad Input',
    'airConditionerFanMode': 'Fan Control', 'fanMode': 'Fan Control', 'fanSpeedPercent': 'Fan Control', 'windMode': 'Fan Control (wind)',
    'airPurifierFanMode': 'Fan Control', 'filterState': 'HEPA Filter Monitoring', 'filterStatus': 'HEPA Filter Monitoring',
    'smokeDetector': 'Smoke CO Alarm', 'carbonMonoxideDetector': 'Smoke CO Alarm', 'hardwareFault': 'Smoke CO Alarm (hardware fault)',
    'robotCleanerOperatingState': 'RVC Operational State', 'operationalState': 'Operational State',
    'laundryWasherRinseMode': 'Laundry Washer Controls', 'laundryWasherSpinSpeed': 'Laundry Washer Controls',
    'waterFlowAlarm': 'Dishwasher Alarm', 'temperatureAlarm': 'Dishwasher Alarm',
    'temperatureSetpoint': 'Temperature Control', 'temperatureLevel': 'Temperature Control', 'cookTime': 'Microwave Oven Control',
    'powerMeter': 'Electrical Power Measurement', 'energyMeter': 'Electrical Energy Measurement',
    'powerConsumptionReport': 'Electrical Energy Measurement', 'evseState': 'Energy EVSE', 'evseChargingSession': 'Energy EVSE',
    'chargingState': 'Power Source (battery charge state)', 'doorControl': 'Closure Control', 'level': 'Closure Dimension',
    'mechanicalPanTiltZoom': 'Camera AV Settings User Level Management', 'hdr': 'Camera AV Stream Management',
    'nightVision': 'Camera AV Stream Management', 'imageControl': 'Camera AV Stream Management',
    'cameraPrivacyMode': 'Camera AV Stream Management (privacy)', 'sounds': 'Chime',
    'audioMute': 'Camera AV Stream Management (audio)', 'audioVolume': 'Camera AV Stream Management (audio)',
    'presenceSensor': 'Occupancy Sensing', 'illuminanceMeasurement': 'Illuminance Measurement', 'refresh': '(SmartThings: re-reads attributes)',
}

v = lambda value, unit=None: {'value': value, **({'unit': unit} if unit else {})}

# id, (driver, profile), name, icon, category, Matter device type, Matter version, options
#   components: keep only these component ids (default: all)
#   extra:      (driver, profile, [component ids]) merged in from another profile
#   modeCluster: Matter cluster behind the generic "mode" capability
#   sample:     sample state injected after creating (component -> capability -> attribute -> value)
MODELS = [
    # ---- Matter 1.0 ----
    ('on-off-light', ('matter-switch', 'light-binary'), 'On/Off light', '💡', 'Lighting', 'On/Off Light', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}}}}),
    ('dimmable-light', ('matter-switch', 'light-level'), 'Dimmable light', '💡', 'Lighting', 'Dimmable Light', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'switchLevel': {'level': v(60, '%')}}}}),
    ('color-temperature-light', ('matter-switch', 'light-level-colorTemperature'), 'Color temperature light', '💡', 'Lighting',
     'Color Temperature Light', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'switchLevel': {'level': v(80, '%')},
                          'colorTemperature': {'colorTemperature': v(3000, 'K')}}}}),
    ('extended-color-light', ('matter-switch', 'light-color-level'), 'Color light', '🌈', 'Lighting', 'Extended Color Light', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'switchLevel': {'level': v(70, '%')},
                          'colorTemperature': {'colorTemperature': v(4000, 'K')},
                          'colorControl': {'hue': v(66), 'saturation': v(80)}}}}),
    ('on-off-plug', ('matter-switch', 'plug-binary'), 'Smart plug', '🔌', 'Plugs & switches', 'On/Off Plug-in Unit', '1.0',
     {'sample': {'main': {'switch': {'switch': v('off')}}}}),
    ('generic-switch', ('matter-switch', 'button-battery'), 'Button', '🔘', 'Plugs & switches', 'Generic Switch', '1.0',
     {'sample': {'main': {'button': {'numberOfButtons': v(1), 'supportedButtonValues': v(['pushed', 'held', 'double'])},
                          'battery': {'battery': v(90, '%')}}}}),
    ('contact-sensor', ('matter-sensor', 'contact-battery'), 'Contact sensor', '🚪', 'Sensors', 'Contact Sensor', '1.0',
     {'sample': {'main': {'contactSensor': {'contact': v('closed')}, 'battery': {'battery': v(95, '%')}}}}),
    ('occupancy-sensor', ('matter-sensor', 'motion-battery'), 'Occupancy (motion) sensor', '🏃', 'Sensors', 'Occupancy Sensor', '1.0',
     {'sample': {'main': {'motionSensor': {'motion': v('inactive')}, 'battery': {'battery': v(88, '%')}}}}),
    ('temperature-humidity-sensor', ('matter-sensor', 'temperature-humidity-battery'), 'Temperature & humidity sensor', '🌡️',
     'Sensors', 'Temperature Sensor + Humidity Sensor', '1.0',
     {'sample': {'main': {'temperatureMeasurement': {'temperature': v(22.5, 'C')},
                          'relativeHumidityMeasurement': {'humidity': v(45, '%')}, 'battery': {'battery': v(80, '%')}}}}),
    ('door-lock', ('matter-lock', 'lock-battery'), 'Door lock', '🔒', 'Security', 'Door Lock', '1.0',
     {'sample': {'main': {'lock': {'lock': v('locked')}, 'lockAlarm': {'alarm': v('clear')},
                          'remoteControlStatus': {'remoteControlEnabled': v('true')}, 'battery': {'battery': v(76, '%')}}}}),
    ('thermostat', ('matter-thermostat', 'thermostat'), 'Thermostat', '🌡️', 'Climate', 'Thermostat', '1.0',
     {'sample': {'main': {'temperatureMeasurement': {'temperature': v(20.5, 'C')},
                          'thermostatMode': {'thermostatMode': v('heat'), 'supportedThermostatModes': v(['off', 'heat', 'cool', 'auto'])},
                          'thermostatHeatingSetpoint': {'heatingSetpoint': v(22, 'C')},
                          'thermostatCoolingSetpoint': {'coolingSetpoint': v(26, 'C')},
                          'thermostatOperatingState': {'thermostatOperatingState': v('heating')}, 'battery': {'battery': v(70, '%')}}}}),
    ('window-covering', ('matter-window-covering', 'window-covering-battery'), 'Blind (window covering)', '🪟', 'Climate',
     'Window Covering', '1.0',
     {'sample': {'main': {'windowShade': {'windowShade': v('partially open'),
                                          'supportedWindowShadeCommands': v(['open', 'close', 'pause'])},
                          'windowShadeLevel': {'shadeLevel': v(50, '%')}, 'battery': {'battery': v(64, '%')}}}}),
    ('video-player', ('matter-media', 'media-video-player'), 'TV (video player)', '📺', 'Appliances', 'Basic Video Player', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'mediaPlayback': {'playbackStatus': v('playing'),
                          'supportedPlaybackCommands': v(['play', 'pause', 'stop'])}}}}),
    # ---- Matter 1.2 ----
    ('room-air-conditioner', ('matter-thermostat', 'room-air-conditioner'), 'Air conditioner', '❄️', 'Climate',
     'Room Air Conditioner', '1.2',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'temperatureMeasurement': {'temperature': v(27, 'C')},
                          'relativeHumidityMeasurement': {'humidity': v(60, '%')},
                          'thermostatMode': {'thermostatMode': v('cool'), 'supportedThermostatModes': v(['off', 'cool', 'heat', 'auto'])},
                          'thermostatCoolingSetpoint': {'coolingSetpoint': v(24, 'C')},
                          'thermostatHeatingSetpoint': {'heatingSetpoint': v(20, 'C')},
                          'thermostatOperatingState': {'thermostatOperatingState': v('cooling')},
                          'airConditionerFanMode': {'fanMode': v('auto'), 'supportedAcFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(50)},
                          'windMode': {'windMode': v('noWind'), 'supportedWindModes': v(['noWind', 'sleepWind', 'naturalWind'])}}}}),
    ('fan', ('matter-thermostat', 'fan'), 'Fan', '🌀', 'Climate', 'Fan', '1.2',
     {'sample': {'main': {'airConditionerFanMode': {'fanMode': v('low'), 'supportedAcFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(30)},
                          'windMode': {'windMode': v('naturalWind'), 'supportedWindModes': v(['noWind', 'sleepWind', 'naturalWind'])}}}}),
    ('air-purifier', ('matter-thermostat', 'air-purifier-hepa'), 'Air purifier', '🍃', 'Climate', 'Air Purifier', '1.2',
     {'sample': {'main': {'airPurifierFanMode': {'airPurifierFanMode': v('auto'),
                                                 'supportedAirPurifierFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(40)}},
                 'hepaFilter': {'filterState': {'filterLifeRemaining': v(85, '%')}, 'filterStatus': {'filterStatus': v('normal')}}}}),
    ('smoke-co-alarm', ('matter-sensor', 'smoke-co-battery'), 'Smoke & CO alarm', '🔥', 'Security', 'Smoke CO Alarm', '1.2',
     {'sample': {'main': {'smokeDetector': {'smoke': v('clear')}, 'carbonMonoxideDetector': {'carbonMonoxide': v('clear')},
                          'hardwareFault': {'hardwareFault': v('clear')}, 'battery': {'battery': v(92, '%')}}}}),
    ('robot-vacuum', ('matter-rvc', 'rvc-clean-mode'), 'Robot vacuum', '🤖', 'Appliances', 'Robotic Vacuum Cleaner', '1.2',
     {'modeCluster': 'RVC Clean Mode',
      'sample': {'main': {'robotCleanerOperatingState': {'operatingState': v('docked')},
                          'mode': {'mode': v('Vacuum'), 'supportedModes': v(['Vacuum', 'Mop', 'Vacuum and mop'])}}}}),
    ('laundry-washer', ('matter-appliance', 'laundry-washer'), 'Washer', '🧺', 'Appliances', 'Laundry Washer', '1.2',
     {'modeCluster': 'Laundry Washer Mode',
      'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Delicate', 'Heavy', 'Whites'])},
                          'operationalState': {'operationalState': v('stopped')},
                          'laundryWasherRinseMode': {'rinseMode': v('normal'), 'supportedRinseModes': v(['none', 'normal', 'extra', 'max'])}}}}),
    ('dishwasher', ('matter-appliance', 'dishwasher'), 'Dishwasher', '🍽️', 'Appliances', 'Dishwasher', '1.2',
     {'modeCluster': 'Dishwasher Mode',
      'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Heavy', 'Light'])},
                          'operationalState': {'operationalState': v('stopped')}, 'contactSensor': {'contact': v('closed')},
                          'waterFlowAlarm': {'rateAlarm': v('normal'), 'volumeAlarm': v('normal')},
                          'temperatureAlarm': {'temperatureAlarm': v('cleared')}}}}),
    ('refrigerator', ('matter-appliance', 'refrigerator-freezer'), 'Refrigerator', '🧊', 'Appliances',
     'Refrigerator (with freezer cabinet)', '1.2',
     {'modeCluster': 'Refrigerator And Temperature Controlled Cabinet Mode',
      'sample': {'main': {'contactSensor': {'contact': v('closed')}},
                 'refrigerator': {'temperatureMeasurement': {'temperature': v(3, 'C')}, 'temperatureSetpoint': {'temperatureSetpoint': v(3, 'C')}},
                 'freezer': {'temperatureMeasurement': {'temperature': v(-18, 'C')}, 'temperatureSetpoint': {'temperatureSetpoint': v(-18, 'C')}}}}),
    # ---- Matter 1.3 ----
    ('laundry-dryer', ('matter-appliance', 'laundry-dryer'), 'Dryer', '🌬️', 'Appliances', 'Laundry Dryer', '1.3',
     {'modeCluster': 'Laundry Washer Mode',
      'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Quick', 'Super Dry'])},
                          'operationalState': {'operationalState': v('stopped')}}}}),
    ('microwave-oven', ('matter-appliance', 'microwave-oven'), 'Microwave', '♨️', 'Appliances', 'Microwave Oven', '1.3',
     {'modeCluster': 'Microwave Oven Mode',
      'sample': {'main': {'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Defrost'])},
                          'operationalState': {'operationalState': v('stopped')}, 'cookTime': {'cookTime': v(90)}}}}),
    ('oven', ('matter-appliance', 'oven-cabinet-one-tn-cabinet-two-tl-cook-top-cook-surface-one-tl-cook-surface-two-tl'), 'Oven (two cavities)',
     '🔥', 'Appliances', 'Oven', '1.3',
     {'components': ['main', 'tccOne', 'tccTwo'], 'modeCluster': 'Oven Mode',
      'sample': {'tccOne': {'mode': {'mode': v('Bake'), 'supportedModes': v(['Bake', 'Convection', 'Grill'])},
                            'temperatureMeasurement': {'temperature': v(25, 'C')}, 'temperatureSetpoint': {'temperatureSetpoint': v(180, 'C')}},
                 'tccTwo': {'mode': {'mode': v('Bake'), 'supportedModes': v(['Bake', 'Convection', 'Grill'])},
                            'temperatureMeasurement': {'temperature': v(25, 'C')},
                            'temperatureLevel': {'temperatureLevel': v('Level 2'), 'supportedTemperatureLevels': v(['Level 1', 'Level 2', 'Level 3'])}}}}),
    ('cooktop', ('matter-appliance', 'cook-top'), 'Cooktop (two burners)', '🍳', 'Appliances', 'Cooktop', '1.3',
     {'extra': ('matter-appliance', 'oven-cabinet-one-tn-cabinet-two-tl-cook-top-cook-surface-one-tl-cook-surface-two-tl',
                ['cookSurfaceOne', 'cookSurfaceTwo']),
      'sample': {'main': {'switch': {'switch': v('on')}},
                 'cookSurfaceOne': {'temperatureLevel': {'temperatureLevel': v('Level 3'), 'supportedTemperatureLevels': v(['Level 1', 'Level 2', 'Level 3'])},
                                    'temperatureMeasurement': {'temperature': v(120, 'C')}},
                 'cookSurfaceTwo': {'temperatureLevel': {'temperatureLevel': v('Level 1'), 'supportedTemperatureLevels': v(['Level 1', 'Level 2', 'Level 3'])},
                                    'temperatureMeasurement': {'temperature': v(25, 'C')}}}}),
    ('extractor-hood', ('matter-appliance', 'extractor-hood-light'), 'Range hood', '💨', 'Appliances', 'Extractor Hood', '1.3',
     {'sample': {'main': {'fanMode': {'fanMode': v('low'), 'supportedFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(33)}},
                 'light': {'switch': {'switch': v('off')}}}}),
    ('water-leak-detector', ('matter-sensor', 'leak-battery'), 'Water leak sensor', '💧', 'Sensors', 'Water Leak Detector', '1.3',
     {'sample': {'main': {'waterSensor': {'water': v('dry')}, 'battery': {'battery': v(97, '%')}}}}),
    ('energy-plug', ('matter-switch', 'plug-power-energy-powerConsumption'), 'Smart plug with energy meter', '🔌', 'Plugs & switches',
     'On/Off Plug-in Unit + Electrical Sensor', '1.3',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'powerMeter': {'power': v(42.5, 'W')}, 'energyMeter': {'energy': v(1.25, 'kWh')}}}}),
    ('ev-charger', ('matter-energy', 'evse-energy-meas'), 'EV charger', '🚗', 'Energy', 'EVSE (EV charger)', '1.3',
     {'modeCluster': 'Energy EVSE Mode',
      'sample': {'main': {'evseState': {'state': v('notPluggedIn'), 'supplyState': v('chargingEnabled'), 'faultState': v('noError')},
                          'evseChargingSession': {'chargingState': v('stopped')},
                          'mode': {'mode': v('Manual'), 'supportedModes': v(['Manual', 'Time of use', 'Solar charging'])}}}}),
    # ---- Matter 1.4 ----
    ('solar-power', ('matter-energy', 'solar-power'), 'Solar power', '☀️', 'Energy', 'Solar Power', '1.4',
     {'sample': {'main': {'powerMeter': {'power': v(3200, 'W')}, 'energyMeter': {'energy': v(12.4, 'kWh')}}}}),
    ('battery-storage', ('matter-energy', 'battery-storage'), 'Home battery', '🔋', 'Energy', 'Battery Storage', '1.4',
     {'sample': {'main': {'battery': {'battery': v(65, '%')}, 'chargingState': {'chargingState': v('charging')},
                          'powerMeter': {'power': v(1500, 'W')}},
                 'importedEnergy': {'energyMeter': {'energy': v(5.2, 'kWh')}},
                 'exportedEnergy': {'energyMeter': {'energy': v(3.1, 'kWh')}}}}),
    ('heat-pump', ('matter-thermostat', 'heat-pump'), 'Heat pump', '♨️', 'Energy', 'Heat Pump', '1.4',
     {'sample': {'main': {'powerMeter': {'power': v(1800, 'W')}, 'energyMeter': {'energy': v(240, 'kWh')}}}}),
    ('water-heater', ('matter-thermostat', 'water-heater'), 'Water heater', '🚿', 'Energy', 'Water Heater', '1.4',
     {'modeCluster': 'Water Heater Mode',
      'sample': {'main': {'temperatureMeasurement': {'temperature': v(48, 'C')},
                          'thermostatMode': {'thermostatMode': v('heat'), 'supportedThermostatModes': v(['off', 'heat'])},
                          'thermostatHeatingSetpoint': {'heatingSetpoint': v(55, 'C')},
                          'mode': {'mode': v('Off'), 'supportedModes': v(['Off', 'Manual', 'Timed'])}}}}),
    # ---- Matter 1.5 ----
    ('camera', ('matter-switch', 'camera'), 'Camera / video doorbell', '📷', 'Security', 'Camera (with doorbell)', '1.5',
     {'components': ['main', 'speaker', 'microphone', 'doorbell'],
      'sample': {'main': {'motionSensor': {'motion': v('inactive')}, 'battery': {'battery': v(82, '%')}},
                 'speaker': {'audioMute': {'mute': v('unmuted')}, 'audioVolume': {'volume': v(50, '%')}},
                 'microphone': {'audioMute': {'mute': v('unmuted')}, 'audioVolume': {'volume': v(70, '%')}},
                 'doorbell': {'button': {'numberOfButtons': v(1), 'supportedButtonValues': v(['pushed'])}}}}),
    ('closure', ('matter-window-covering', 'garage-door'), 'Garage door / gate', '🚘', 'Security', 'Closure (garage door, gate)', '1.5',
     {'components': ['main'],
      'sample': {'main': {'doorControl': {'door': v('closed')}, 'level': {'level': v(0, '%')}, 'battery': {'battery': v(90, '%')}}}}),
    ('soil-sensor', ('matter-sensor', 'soil-sensor-battery'), 'Soil moisture sensor', '🌱', 'Sensors', 'Soil Sensor', '1.5',
     {'sample': {'main': {'relativeHumidityMeasurement': {'humidity': v(35, '%')}, 'battery': {'battery': v(77, '%')}}}}),
]


def load_profile(driver, profile):
    with open(os.path.join(drivers, driver, 'profiles', profile + '.yml')) as f:
        return yaml.safe_load(f)


def convert(components, only=None):
    out = []
    for c in components:
        if only and c['id'] not in only:
            continue
        caps = [{'id': x['id'], 'version': x.get('version', 1)} for x in c.get('capabilities', []) if keep(x['id'])]
        comp = {'id': c['id'], 'capabilities': caps}
        if c.get('categories'):
            comp['categories'] = [{'name': x['name']} for x in c['categories']]
        out.append(comp)
    return out


def sanitize_profile_name(name):
    # SmartThings virtualdevices:create rejects '/', '&', ',' in deviceProfile.name with HTTP 422.
    s = name.replace('&', ' and ').replace('/', '-')
    s = re.sub(r'[^A-Za-z0-9 ()_-]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip() or 'Virtual Profile'


templates = []
for tid, (driver, profile), name, icon, category, matter_type, version, opt in MODELS:
    src = load_profile(driver, profile)
    comps = convert(src['components'], opt.get('components'))
    sources = [f'{driver}/profiles/{profile}.yml']
    if 'extra' in opt:
        xd, xp, xc = opt['extra']
        comps += convert(load_profile(xd, xp)['components'], xc)
        sources.append(f'{xd}/profiles/{xp}.yml')
    assert comps and comps[0]['id'] == 'main', tid
    have = {(c['id'], x['id']) for c in comps for x in c['capabilities']}
    sample = opt.get('sample', {})
    for comp, caps in sample.items():
        for cap in caps:
            assert (comp, cap) in have, f'{tid}: sample state uses {comp}/{cap}, which the profile does not have'
    mapping, seen = [], set()
    for c in comps:
        for x in c['capabilities']:
            if x['id'] in seen:
                continue
            seen.add(x['id'])
            cluster = opt.get('modeCluster') if x['id'] == 'mode' else CLUSTER.get(x['id'])
            assert cluster, f'{tid}: no Matter cluster known for {x["id"]}'
            mapping.append({'cluster': cluster, 'capability': x['id']})
    n_caps = len(seen)
    templates.append({
        'id': f'matter-{tid}', 'name': name, 'icon': icon, 'category': category,
        'matter': {'deviceType': matter_type, 'version': version},
        'description': f'Matter {version} · {matter_type} · {n_caps} capabilities',
        'source': {'profiles': sources},
        'mapping': mapping,
        'deviceProfile': {'name': sanitize_profile_name(f'Virtual Matter {name}'), 'components': comps},
        'sampleState': sample,
    })

out = {
    'generatedFrom': {
        'repository': 'https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers',
        'commit': commit, 'path': 'drivers/SmartThings/matter-*/profiles', 'license': 'Apache-2.0',
    },
    'matterVersion': '1.5',
    'templates': templates,
}
dest = os.path.join(os.path.dirname(__file__), '..', 'templates', 'matter-devices.json')
with open(dest, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print(f'{len(templates)} Matter templates written to {os.path.normpath(dest)} (from {commit[:12]})')
