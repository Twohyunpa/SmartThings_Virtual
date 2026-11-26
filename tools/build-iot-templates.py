#!/usr/bin/env python3
"""Build templates/iot-devices.json from SmartThings' official Edge drivers.

When a real device is added to SmartThings, its Edge driver gives it a device profile made of standard
capabilities. Those profiles live in https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers
(drivers/SmartThings/*/profiles, Apache-2.0). We copy the standard capability lists of common profiles
so that a cloud *virtual* device looks the same to apps, automations and the API as a real device of
that type. The virtual device does not talk Matter, Zigbee or Z-Wave.

The device types and categories follow the Matter Device Library (Matter 1.5), because it is the
only cross-vendor list of smart home device types. Most profiles come from the matter-* drivers; a
few sensors come from zigbee-* / zwave-* drivers where no Matter profile fits.

A few device types that no SmartThings driver profile covers (gas meter, gas detector) come from real
devices in Home Assistant's SmartThings test fixtures (https://github.com/home-assistant/core,
tests/components/smartthings/fixtures, Apache-2.0), the same source as templates/samsung-appliances.json.

Usage:
  git clone --depth 1 --filter=blob:none --sparse https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers ste
  git -C ste sparse-checkout set --no-cone '/drivers/SmartThings/*/profiles/*'
  git clone --depth 1 --filter=blob:none --sparse https://github.com/home-assistant/core ha-core
  git -C ha-core sparse-checkout set tests/components/smartthings
  python3 tools/build-iot-templates.py ste ha-core

Requires PyYAML (pip install pyyaml).
"""
import json, os, re, subprocess, sys

import yaml

root = sys.argv[1] if len(sys.argv) > 1 else 'ste'
drivers = os.path.join(root, 'drivers', 'SmartThings')
commit = subprocess.run(['git', '-C', root, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
ha_root = sys.argv[2] if len(sys.argv) > 2 else 'ha-core'
ha_fixtures = os.path.join(ha_root, 'tests', 'components', 'smartthings', 'fixtures')
ha_commit = subprocess.run(['git', '-C', ha_root, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()

# Capabilities that mean nothing on a virtual device: firmware plumbing, command-only "stateless" step
# capabilities, and the camera streaming / storage capabilities (a virtual camera has no video).
DROP = {
    'firmwareUpdate', 'batteryLevel',
    'webrtc', 'videoCapture2', 'videoStreamSettings', 'imageCapture', 'localMediaStorage',
    'zoneManagement', 'cameraViewportSettings', 'audioRecording',
    'healthCheck', 'signalStrength', 'momentary',  # cloud plumbing / radio quality / command-only (HA fixtures)
}

def keep(cap_id):
    # Standard (namespace-less) capabilities only: vendor ones such as vision.* are left out.
    return '.' not in cap_id and cap_id not in DROP and not cap_id.startswith('stateless')

# Chapters of the Matter Device Library, used as the categories of the GUI (in this order).
CATEGORIES = ['Lighting', 'Plugs and actuators', 'Switches and controls', 'Sensors', 'Closures', 'HVAC',
              'Media', 'Robotic', 'Appliances', 'Energy management', 'Cameras', 'Other']

v = lambda value, unit=None: {'value': value, **({'unit': unit} if unit else {})}

# id, (driver, profile), name, icon, category, Matter device type, Matter version, options
#   Matter device type / version: the closest Matter device type, for reference (None when there is none)
#   components: keep only these component ids (default: all)
#   extra:      (driver, profile, [component ids]) merged in from another profile
#   stCategory: SmartThings device category for the main component (default: the profile's own)
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
    ('on-off-plug', ('matter-switch', 'plug-binary'), 'Smart plug', '🔌', 'Plugs and actuators', 'On/Off Plug-in Unit', '1.0',
     {'sample': {'main': {'switch': {'switch': v('off')}}}}),
    ('generic-switch', ('matter-switch', 'button-battery'), 'Button', '🔘', 'Switches and controls', 'Generic Switch', '1.0',
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
    ('door-lock', ('matter-lock', 'lock-battery'), 'Door lock', '🔒', 'Closures', 'Door Lock', '1.0',
     {'sample': {'main': {'lock': {'lock': v('locked')}, 'lockAlarm': {'alarm': v('clear')},
                          'remoteControlStatus': {'remoteControlEnabled': v('true')}, 'battery': {'battery': v(76, '%')}}}}),
    ('thermostat', ('matter-thermostat', 'thermostat'), 'Thermostat', '🌡️', 'HVAC', 'Thermostat', '1.0',
     {'sample': {'main': {'temperatureMeasurement': {'temperature': v(20.5, 'C')},
                          'thermostatMode': {'thermostatMode': v('heat'), 'supportedThermostatModes': v(['off', 'heat', 'cool', 'auto'])},
                          'thermostatHeatingSetpoint': {'heatingSetpoint': v(22, 'C')},
                          'thermostatCoolingSetpoint': {'coolingSetpoint': v(26, 'C')},
                          'thermostatOperatingState': {'thermostatOperatingState': v('heating')}, 'battery': {'battery': v(70, '%')}}}}),
    ('window-covering', ('matter-window-covering', 'window-covering-battery'), 'Blind (window covering)', '🪟', 'Closures',
     'Window Covering', '1.0',
     {'sample': {'main': {'windowShade': {'windowShade': v('partially open'),
                                          'supportedWindowShadeCommands': v(['open', 'close', 'pause'])},
                          'windowShadeLevel': {'shadeLevel': v(50, '%')}, 'battery': {'battery': v(64, '%')}}}}),
    ('video-player', ('matter-media', 'media-video-player'), 'TV (video player)', '📺', 'Media', 'Basic Video Player', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'mediaPlayback': {'playbackStatus': v('playing'),
                          'supportedPlaybackCommands': v(['play', 'pause', 'stop'])}}}}),
    # ---- Matter 1.2 ----
    ('room-air-conditioner', ('matter-thermostat', 'room-air-conditioner'), 'Air conditioner', '❄️', 'Appliances',
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
    ('fan', ('matter-thermostat', 'fan'), 'Fan', '🌀', 'HVAC', 'Fan', '1.2',
     {'sample': {'main': {'airConditionerFanMode': {'fanMode': v('low'), 'supportedAcFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(30)},
                          'windMode': {'windMode': v('naturalWind'), 'supportedWindModes': v(['noWind', 'sleepWind', 'naturalWind'])}}}}),
    ('air-purifier', ('matter-thermostat', 'air-purifier-hepa'), 'Air purifier', '🍃', 'HVAC', 'Air Purifier', '1.2',
     {'sample': {'main': {'airPurifierFanMode': {'airPurifierFanMode': v('auto'),
                                                 'supportedAirPurifierFanModes': v(['off', 'low', 'medium', 'high', 'auto'])},
                          'fanSpeedPercent': {'percent': v(40)}},
                 'hepaFilter': {'filterState': {'filterLifeRemaining': v(85, '%')}, 'filterStatus': {'filterStatus': v('normal')}}}}),
    ('smoke-co-alarm', ('matter-sensor', 'smoke-co-battery'), 'Smoke & CO alarm', '🔥', 'Sensors', 'Smoke CO Alarm', '1.2',
     {'sample': {'main': {'smokeDetector': {'smoke': v('clear')}, 'carbonMonoxideDetector': {'carbonMonoxide': v('clear')},
                          'hardwareFault': {'hardwareFault': v('clear')}, 'battery': {'battery': v(92, '%')}}}}),
    ('robot-vacuum', ('matter-rvc', 'rvc-clean-mode'), 'Robot vacuum', '🤖', 'Robotic', 'Robotic Vacuum Cleaner', '1.2',
     {'sample': {'main': {'robotCleanerOperatingState': {'operatingState': v('docked')},
                          'mode': {'mode': v('Vacuum'), 'supportedModes': v(['Vacuum', 'Mop', 'Vacuum and mop'])}}}}),
    ('laundry-washer', ('matter-appliance', 'laundry-washer'), 'Washer', '🧺', 'Appliances', 'Laundry Washer', '1.2',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Delicate', 'Heavy', 'Whites'])},
                          'operationalState': {'operationalState': v('stopped')},
                          'laundryWasherRinseMode': {'rinseMode': v('normal'), 'supportedRinseModes': v(['none', 'normal', 'extra', 'max'])}}}}),
    ('dishwasher', ('matter-appliance', 'dishwasher'), 'Dishwasher', '🍽️', 'Appliances', 'Dishwasher', '1.2',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Heavy', 'Light'])},
                          'operationalState': {'operationalState': v('stopped')}, 'contactSensor': {'contact': v('closed')},
                          'waterFlowAlarm': {'rateAlarm': v('normal'), 'volumeAlarm': v('normal')},
                          'temperatureAlarm': {'temperatureAlarm': v('cleared')}}}}),
    ('refrigerator', ('matter-appliance', 'refrigerator-freezer'), 'Refrigerator', '🧊', 'Appliances',
     'Refrigerator (with freezer cabinet)', '1.2',
     {'sample': {'main': {'contactSensor': {'contact': v('closed')}},
                 'refrigerator': {'temperatureMeasurement': {'temperature': v(3, 'C')}, 'temperatureSetpoint': {'temperatureSetpoint': v(3, 'C')}},
                 'freezer': {'temperatureMeasurement': {'temperature': v(-18, 'C')}, 'temperatureSetpoint': {'temperatureSetpoint': v(-18, 'C')}}}}),
    # ---- Matter 1.3 ----
    ('laundry-dryer', ('matter-appliance', 'laundry-dryer'), 'Dryer', '🌬️', 'Appliances', 'Laundry Dryer', '1.3',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Quick', 'Super Dry'])},
                          'operationalState': {'operationalState': v('stopped')}}}}),
    ('microwave-oven', ('matter-appliance', 'microwave-oven'), 'Microwave', '♨️', 'Appliances', 'Microwave Oven', '1.3',
     {'sample': {'main': {'mode': {'mode': v('Normal'), 'supportedModes': v(['Normal', 'Defrost'])},
                          'operationalState': {'operationalState': v('stopped')}, 'cookTime': {'cookTime': v(90)}}}}),
    ('oven', ('matter-appliance', 'oven-cabinet-one-tn-cabinet-two-tl-cook-top-cook-surface-one-tl-cook-surface-two-tl'), 'Oven (two cavities)',
     '🔥', 'Appliances', 'Oven', '1.3',
     {'components': ['main', 'tccOne', 'tccTwo'], 'sample': {'tccOne': {'mode': {'mode': v('Bake'), 'supportedModes': v(['Bake', 'Convection', 'Grill'])},
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
    ('energy-plug', ('matter-switch', 'plug-power-energy-powerConsumption'), 'Smart plug with energy meter', '🔌', 'Plugs and actuators',
     'On/Off Plug-in Unit + Electrical Sensor', '1.3',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'powerMeter': {'power': v(42.5, 'W')}, 'energyMeter': {'energy': v(1.25, 'kWh')}}}}),
    ('ev-charger', ('matter-energy', 'evse-energy-meas'), 'EV charger', '🚗', 'Energy management', 'EVSE (EV charger)', '1.3',
     {'sample': {'main': {'evseState': {'state': v('notPluggedIn'), 'supplyState': v('chargingEnabled'), 'faultState': v('noError')},
                          'evseChargingSession': {'chargingState': v('stopped')},
                          'mode': {'mode': v('Manual'), 'supportedModes': v(['Manual', 'Time of use', 'Solar charging'])}}}}),
    # ---- Matter 1.4 ----
    ('solar-power', ('matter-energy', 'solar-power'), 'Solar power', '☀️', 'Energy management', 'Solar Power', '1.4',
     {'sample': {'main': {'powerMeter': {'power': v(3200, 'W')}, 'energyMeter': {'energy': v(12.4, 'kWh')}}}}),
    ('battery-storage', ('matter-energy', 'battery-storage'), 'Home battery', '🔋', 'Energy management', 'Battery Storage', '1.4',
     {'sample': {'main': {'battery': {'battery': v(65, '%')}, 'chargingState': {'chargingState': v('charging')},
                          'powerMeter': {'power': v(1500, 'W')}},
                 'importedEnergy': {'energyMeter': {'energy': v(5.2, 'kWh')}},
                 'exportedEnergy': {'energyMeter': {'energy': v(3.1, 'kWh')}}}}),
    ('heat-pump', ('matter-thermostat', 'heat-pump'), 'Heat pump', '♨️', 'HVAC', 'Heat Pump', '1.4',
     {'sample': {'main': {'powerMeter': {'power': v(1800, 'W')}, 'energyMeter': {'energy': v(240, 'kWh')}}}}),
    ('water-heater', ('matter-thermostat', 'water-heater'), 'Water heater', '🚿', 'Energy management', 'Water Heater', '1.4',
     {'sample': {'main': {'temperatureMeasurement': {'temperature': v(48, 'C')},
                          'thermostatMode': {'thermostatMode': v('heat'), 'supportedThermostatModes': v(['off', 'heat'])},
                          'thermostatHeatingSetpoint': {'heatingSetpoint': v(55, 'C')},
                          'mode': {'mode': v('Off'), 'supportedModes': v(['Off', 'Manual', 'Timed'])}}}}),
    # ---- Matter 1.5 ----
    ('camera', ('matter-switch', 'camera'), 'Camera / video doorbell', '📷', 'Cameras', 'Camera (with doorbell)', '1.5',
     {'components': ['main', 'speaker', 'microphone', 'doorbell'],
      'sample': {'main': {'motionSensor': {'motion': v('inactive')}, 'battery': {'battery': v(82, '%')}},
                 'speaker': {'audioMute': {'mute': v('unmuted')}, 'audioVolume': {'volume': v(50, '%')}},
                 'microphone': {'audioMute': {'mute': v('unmuted')}, 'audioVolume': {'volume': v(70, '%')}},
                 'doorbell': {'button': {'numberOfButtons': v(1), 'supportedButtonValues': v(['pushed'])}}}}),
    ('closure', ('matter-window-covering', 'garage-door'), 'Garage door / gate', '🚘', 'Closures', 'Closure (garage door, gate)', '1.5',
     {'components': ['main'],
      'sample': {'main': {'doorControl': {'door': v('closed')}, 'level': {'level': v(0, '%')}, 'battery': {'battery': v(90, '%')}}}}),
    ('soil-sensor', ('matter-sensor', 'soil-sensor-battery'), 'Soil moisture sensor', '🌱', 'Sensors', 'Soil Sensor', '1.5',
     {'sample': {'main': {'relativeHumidityMeasurement': {'humidity': v(35, '%')}, 'battery': {'battery': v(77, '%')}}}}),
    # ---- More sensors (SmartThings categories that had no template before) ----
    ('presence-sensor', ('matter-sensor', 'presence-illuminance-temperature-humidity-battery'), 'Presence sensor', '🧍', 'Sensors',
     'Occupancy Sensor (radar)', '1.4',
     {'sample': {'main': {'presenceSensor': {'presence': v('present')}, 'temperatureMeasurement': {'temperature': v(22, 'C')},
                          'relativeHumidityMeasurement': {'humidity': v(48, '%')}, 'illuminanceMeasurement': {'illuminance': v(320, 'lux')},
                          'battery': {'battery': v(90, '%')}}}}),
    ('arrival-sensor', ('zigbee-presence-sensor', 'smartthings-arrival-sensor'), 'Arrival sensor', '🏠', 'Sensors', None, None,
     {'stCategory': 'MobilePresence',
      'sample': {'main': {'presenceSensor': {'presence': v('not present')}, 'battery': {'battery': v(85, '%')}}}}),
    ('light-sensor', ('matter-sensor', 'illuminance-battery'), 'Light sensor', '🔆', 'Sensors', 'Light Sensor', '1.0',
     {'sample': {'main': {'illuminanceMeasurement': {'illuminance': v(250, 'lux')}, 'battery': {'battery': v(93, '%')}}}}),
    ('temperature-sensor', ('matter-sensor', 'temperature-battery'), 'Temperature sensor', '🌡️', 'Sensors', 'Temperature Sensor', '1.0',
     {'stCategory': 'TempSensor',
      'sample': {'main': {'temperatureMeasurement': {'temperature': v(21.5, 'C')}, 'battery': {'battery': v(88, '%')}}}}),
    ('sound-sensor', ('zigbee-sound-sensor', 'battery-sound-temperature'), 'Sound sensor', '🔉', 'Sensors', None, None,
     {'stCategory': 'SoundSensor',
      'sample': {'main': {'soundSensor': {'sound': v('not detected')}, 'temperatureMeasurement': {'temperature': v(22, 'C')},
                          'battery': {'battery': v(91, '%')}}}}),
    ('water-freeze-detector', ('matter-sensor', 'freeze-battery'), 'Water freeze detector', '🥶', 'Sensors', 'Water Freeze Detector', '1.3',
     {'sample': {'main': {'temperatureAlarm': {'temperatureAlarm': v('cleared')}, 'battery': {'battery': v(95, '%')}}}}),
    ('flow-sensor', ('matter-sensor', 'flow-battery'), 'Flow sensor', '🚰', 'Sensors', 'Flow Sensor', '1.0',
     {'sample': {'main': {'flowMeasurement': {'flow': v(1.2, 'm^3/h')}, 'battery': {'battery': v(80, '%')}}}}),
    ('rain-sensor', ('matter-sensor', 'rain-battery'), 'Rain sensor', '🌧️', 'Sensors', 'Rain Sensor', '1.3',
     {'sample': {'main': {'rainSensor': {'rain': v('not detected')}, 'battery': {'battery': v(87, '%')}}}}),
    ('air-quality-sensor', ('matter-sensor', 'aqs-temp-humidity-co2-pm25-tvoc-meas'), 'Indoor air quality sensor', '🌫️', 'Sensors',
     'Air Quality Sensor', '1.2',
     {'stCategory': 'EnvironmentSensor',
      'sample': {'main': {'airQualityHealthConcern': {'airQualityHealthConcern': v('good')},
                          'temperatureMeasurement': {'temperature': v(23, 'C')}, 'relativeHumidityMeasurement': {'humidity': v(42, '%')},
                          'carbonDioxideMeasurement': {'carbonDioxide': v(650, 'ppm')}, 'fineDustSensor': {'fineDustLevel': v(8, 'μg/m^3')},
                          'tvocMeasurement': {'tvocLevel': v(0.12, 'ppm')}}}}),
    ('multi-sensor', ('zigbee-contact', 'multi-sensor'), 'Multipurpose sensor', '📳', 'Sensors', None, None,
     {'sample': {'main': {'contactSensor': {'contact': v('closed')}, 'accelerationSensor': {'acceleration': v('inactive')},
                          'threeAxis': {'threeAxis': v([0, 0, 1000], 'mG')}, 'temperatureMeasurement': {'temperature': v(21, 'C')},
                          'battery': {'battery': v(86, '%')}}}}),
    ('pressure-sensor', ('matter-sensor', 'pressure-battery'), 'Pressure sensor', '⏲️', 'Sensors', 'Pressure Sensor', '1.0',
     {'sample': {'main': {'atmosphericPressureMeasurement': {'atmosphericPressure': v(101.3, 'kPa')}, 'battery': {'battery': v(90, '%')}}}}),
    ('zone-sensor', ('zwave-sensor', 'contact-battery-tamperalert'), 'Security zone sensor', '🛡️', 'Sensors', None, None,
     {'stCategory': 'ZoneSensor',
      'sample': {'main': {'contactSensor': {'contact': v('closed')}, 'tamperAlert': {'tamper': v('clear')},
                          'battery': {'battery': v(92, '%')}}}}),
    ('weather-station', ('matter-sensor', 'temperature-humidity-pressure-battery'), 'Weather station', '⛅', 'Sensors',
     'Temperature Sensor + Humidity Sensor + Pressure Sensor', '1.0',
     {'stCategory': 'WeatherStation',
      'sample': {'main': {'temperatureMeasurement': {'temperature': v(14, 'C')}, 'relativeHumidityMeasurement': {'humidity': v(70, '%')},
                          'atmosphericPressureMeasurement': {'atmosphericPressure': v(100.8, 'kPa')}, 'battery': {'battery': v(75, '%')}}}}),
    ('co-alarm', ('matter-sensor', 'co-comeas-battery'), 'Carbon monoxide alarm', '⚠️', 'Sensors', 'Smoke CO Alarm (CO only)', '1.2',
     {'sample': {'main': {'carbonMonoxideDetector': {'carbonMonoxide': v('clear')},
                          'carbonMonoxideMeasurement': {'carbonMonoxideLevel': v(0, 'ppm')}, 'hardwareFault': {'hardwareFault': v('clear')},
                          'battery': {'battery': v(94, '%')}}}}),
    # ---- Safety, power and water ----
    ('siren', ('zigbee-siren', 'switch-alarm'), 'Siren', '🚨', 'Other', None, None,
     {'sample': {'main': {'switch': {'switch': v('off')}, 'alarm': {'alarm': v('off')}}}}),
    ('panic-button', ('zigbee-button', 'button-profile-panic-frient'), 'Panic button', '🆘', 'Switches and controls', None, None,
     {'stCategory': 'PanicButton',
      'sample': {'main': {'panicAlarm': {'panicAlarm': v('clear')},
                          'button': {'numberOfButtons': v(1), 'supportedButtonValues': v(['pushed'])},
                          'battery': {'battery': v(90, '%')}}}}),
    ('door', ('matter-window-covering', 'door'), 'Door opener', '🚪', 'Closures', 'Closure (door)', '1.5',
     {'components': ['main'],
      'sample': {'main': {'doorControl': {'door': v('closed')}, 'level': {'level': v(0, '%')}, 'battery': {'battery': v(88, '%')}}}}),
    ('wall-switch', ('matter-switch', 'switch-binary'), 'Wall switch', '🎚️', 'Switches and controls', 'On/Off Light Switch', '1.0',
     {'sample': {'main': {'switch': {'switch': v('off')}}}}),
    ('power-meter', ('zigbee-power-meter', 'frient-power-energy-current-voltage'), 'Power meter (3 phase)', '⚡', 'Energy management',
     'Electrical Sensor', '1.3',
     {'sample': {'main': {'powerMeter': {'power': v(2350, 'W')}, 'energyMeter': {'energy': v(1520.4, 'kWh')}},
                 'production': {'energyMeter': {'energy': v(310.2, 'kWh')}},
                 'phaseA': {'powerMeter': {'power': v(820, 'W')}, 'voltageMeasurement': {'voltage': v(230, 'V')},
                            'currentMeasurement': {'current': v(3.6, 'A')}},
                 'phaseB': {'powerMeter': {'power': v(760, 'W')}, 'voltageMeasurement': {'voltage': v(231, 'V')},
                            'currentMeasurement': {'current': v(3.3, 'A')}},
                 'phaseC': {'powerMeter': {'power': v(770, 'W')}, 'voltageMeasurement': {'voltage': v(229, 'V')},
                            'currentMeasurement': {'current': v(3.4, 'A')}}}}),
    ('home-energy-meter', ('zwave-electric-meter', 'base-electric-meter'), 'Home energy meter', '🏠', 'Energy management',
     'Electrical Sensor', '1.3',
     {'sample': {'main': {'powerMeter': {'power': v(1840, 'W')}, 'energyMeter': {'energy': v(8421.7, 'kWh')}}}}),
    ('water-valve', ('zigbee-valve', 'valve-battery-powerSource'), 'Water valve', '🚰', 'Plugs and actuators', 'Water Valve', '1.4',
     {'sample': {'main': {'valve': {'valve': v('open')}, 'battery': {'battery': v(83, '%')}, 'powerSource': {'powerSource': v('battery')}}}}),
    ('gas-valve', ('zwave-valve', 'valve-generic'), 'Gas valve', '🔥', 'Plugs and actuators', None, None,
     {'stCategory': 'GasValve',
      'sample': {'main': {'valve': {'valve': v('open')}}}}),
    ('irrigation', ('matter-switch', 'irrigation-system'), 'Irrigation controller', '🌿', 'Plugs and actuators', 'Irrigation System', '1.5',
     {'sample': {'main': {'valve': {'valve': v('closed')}, 'level': {'level': v(0, '%')}, 'flowMeasurement': {'flow': v(0, 'm^3/h')},
                          'operationalState': {'operationalState': v('stopped')}}}}),
    ('pump', ('matter-pump', 'pump-level'), 'Pump', '⛽', 'HVAC', 'Pump', '1.0',
     {'sample': {'main': {'switch': {'switch': v('on')}, 'switchLevel': {'level': v(60, '%')},
                          'pumpOperationMode': {'operationMode': v('normal'), 'supportedOperationModes': v(['normal', 'minimum', 'maximum'])},
                          'pumpControlMode': {'controlMode': v('constantSpeed'),
                                              'supportedControlModes': v(['constantSpeed', 'constantPressure', 'automatic'])}}}}),
]

# Device types with no SmartThings driver profile, taken from real devices in the Home Assistant fixtures:
# id, fixture, name, icon, category, Matter device type, Matter version, SmartThings category (None: keep)
HA_MODELS = [
    ('gas-meter', 'gas_meter', 'Gas meter', '🔥', 'Energy management', None, None, None),
    ('gas-detector', 'gas_detector', 'Gas leak detector', '💨', 'Sensors', None, None, None),
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
    # SmartThings virtualdevices:create rejects '/', '&', ',' in deviceProfile.name with HTTP 422;
    # brackets and other symbols are dropped too, to be safe.
    s = name.replace('&', ' and ').replace('/', '-')
    s = re.sub(r'[^A-Za-z0-9 _-]', ' ', s)
    return re.sub(r'\s+', ' ', s).strip() or 'Virtual Profile'


templates = []
for tid, (driver, profile), name, icon, category, matter_type, version, opt in MODELS:
    assert category in CATEGORIES, f'{tid}: unknown category {category}'
    src = load_profile(driver, profile)
    comps = convert(src['components'], opt.get('components'))
    sources = [f'{driver}/profiles/{profile}.yml']
    if 'extra' in opt:
        xd, xp, xc = opt['extra']
        comps += convert(load_profile(xd, xp)['components'], xc)
        sources.append(f'{xd}/profiles/{xp}.yml')
    assert comps and comps[0]['id'] == 'main', tid
    if 'stCategory' in opt:
        comps[0]['categories'] = [{'name': opt['stCategory']}]
    have = {(c['id'], x['id']) for c in comps for x in c['capabilities']}
    sample = opt.get('sample', {})
    for comp, caps in sample.items():
        for cap in caps:
            assert (comp, cap) in have, f'{tid}: sample state uses {comp}/{cap}, which the profile does not have'
    n_caps = len({x['id'] for c in comps for x in c['capabilities']})
    templates.append({
        'id': f'iot-{tid}', 'name': name, 'icon': icon, 'category': category,
        **({'matter': {'deviceType': matter_type, 'version': version}} if matter_type else {}),
        'description': f'{n_caps} standard capabilities',
        'source': {'profiles': sources},
        'deviceProfile': {'name': sanitize_profile_name(f'Virtual {name}'), 'components': comps},
        'sampleState': sample,
    })

for tid, fixture, name, icon, category, matter_type, version, st_category in HA_MODELS:
    assert category in CATEGORIES, f'{tid}: unknown category {category}'
    dev = json.load(open(os.path.join(ha_fixtures, 'devices', f'{fixture}.json')))['items'][0]
    status = json.load(open(os.path.join(ha_fixtures, 'device_status', f'{fixture}.json')))['components']
    comps, sample = [], {}
    for c in dev['components']:
        caps = [{'id': x['id'], 'version': x.get('version', 1)} for x in c['capabilities'] if keep(x['id'])]
        if not caps:
            continue
        comp = {'id': c['id'], 'capabilities': caps}
        cats = [{'name': k['name']} for k in c.get('categories', [])][:1]
        if c['id'] == 'main' and st_category:
            cats = [{'name': st_category}]
        if cats:
            comp['categories'] = cats
        comps.append(comp)
        for x in caps:
            attrs = {a: {'value': v['value'], **({'unit': v['unit']} if v.get('unit') else {})}
                     for a, v in status.get(c['id'], {}).get(x['id'], {}).items()
                     if isinstance(v, dict) and v.get('value') is not None}
            if attrs:
                sample.setdefault(c['id'], {})[x['id']] = attrs
    assert comps and comps[0]['id'] == 'main' and sample, tid
    n_caps = len({x['id'] for c in comps for x in c['capabilities']})
    templates.append({
        'id': f'iot-{tid}', 'name': name, 'icon': icon, 'category': category,
        **({'matter': {'deviceType': matter_type, 'version': version}} if matter_type else {}),
        'description': f'{n_caps} standard capabilities',
        'source': {'fixture': fixture},
        'deviceProfile': {'name': sanitize_profile_name(f'Virtual {name}'), 'components': comps},
        'sampleState': sample,
    })

out = {
    'generatedFrom': {
        'repository': 'https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers',
        'commit': commit, 'path': 'drivers/SmartThings/*/profiles', 'license': 'Apache-2.0',
        'homeAssistant': {'repository': 'https://github.com/home-assistant/core', 'commit': ha_commit,
                          'path': 'tests/components/smartthings/fixtures', 'license': 'Apache-2.0'},
    },
    'basedOn': 'Matter 1.5 Device Library (device types and categories)',
    'categories': CATEGORIES,
    'templates': templates,
}
dest = os.path.join(os.path.dirname(__file__), '..', 'templates', 'iot-devices.json')
with open(dest, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print(f'{len(templates)} IoT device templates written to {os.path.normpath(dest)} (from {commit[:12]})')
