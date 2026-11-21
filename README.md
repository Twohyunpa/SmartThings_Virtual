# SmartThings Virtual Device Console

[English](README.md) | [한국어](README.ko.md)

![screenshot](docs/screenshot.png)

A local GUI that wraps the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli). Create virtual devices, inject states (events) into them, and replay scenarios from the browser instead of running scripts by hand.

- No npm dependencies. Node.js is all you need.
- The server listens on `127.0.0.1` only and rejects requests from other origins.
- Every CLI command the UI runs is shown in the **CLI command log** at the bottom, so you can copy it into your own scripts.
- Write operations (inject events, rename, delete) are only allowed on virtual devices.

## Quick start

Prerequisites:

1. **Node.js** (the latest CLI 3.x needs Node 24 or newer)
2. **SmartThings CLI**

   ```bash
   npm install -g @smartthings/cli
   # or with Homebrew
   brew install smartthingscommunity/smartthings/smartthings
   smartthings --version
   ```

3. **Authentication** (either one)
   - Browser login: run any command once and the CLI opens a login window, e.g. `smartthings locations`.
   - Personal access token (PAT): create one at https://account.smartthings.com/tokens and pass it as an environment variable. It needs at least the `Devices` (read/write/execute) and `Locations` (read) scopes. New PATs may expire after 24 hours.

     ```bash
     export SMARTTHINGS_TOKEN=xxxxxxxx-xxxx-...
     ```

Run:

```bash
# run without installing anything
npx github:Twohyunpa/SmartThings_Virtual

# or clone and run (Windows / macOS / Linux)
git clone https://github.com/Twohyunpa/SmartThings_Virtual.git
cd SmartThings_Virtual
npm start
```

Your default browser opens http://127.0.0.1:3700 automatically (disable with `--no-open`). On Windows PowerShell, set variables like `$env:SMARTTHINGS_TOKEN="..."; npm start`.

To try the UI without a SmartThings account, run it against the built-in mock CLI:

```bash
npm run mock
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3700` | Web server port |
| `ST_CLI` | `smartthings` | Path to the CLI executable. Paths ending in `.js` are run with `node` |
| `ST_PROFILE` | `default` | CLI config profile. Can also be changed from the top bar |
| `SMARTTHINGS_TOKEN` | – | PAT. Skips the browser login |
| `ST_NO_OPEN` | – | If set, do not open the browser on start (same as `--no-open`) |
| `ST_CLI_TIMEOUT_MS` | `120000` | Maximum run time of a single CLI command |

## Features

**Create virtual devices**
- Samsung appliance templates: 38 real models (washers, dryers, dishwashers, air conditioners, air purifiers, refrigerators, robot vacuums, ovens, cooktops, range hoods, TVs, soundbars ...). Their capability lists and sample attribute values are taken from real devices, see [Where the templates come from](#where-the-templates-come-from). You can open the profile JSON and add or remove capabilities.
- Standard prototypes such as `VIRTUAL_SWITCH` and `VIRTUAL_MOTION_SENSOR` (17 in total, `virtualdevices:create-standard`).
- Create from one of your own device profile IDs, or paste a profile JSON (`virtualdevices:create`).
- The dry-run button shows the request JSON without creating anything.

**State & inject**
- Shows the attributes of every component / capability with their current values.
- Controls are generated from the capability definitions: enums become chips (click to inject immediately), numbers get a slider / input plus a unit, arrays and objects take JSON.
- Optional 5-second auto-refresh, and a custom event form (component / capability / attribute / value / unit).

**Presets & scenarios**
- Template presets (e.g. start wash → rinse → spin → finished) appear automatically when they match the device's capabilities.
- Collect steps with the ＋ buttons on the State tab, set a delay per step, and replay them once or in a loop.
- Scenarios are stored in your browser (localStorage) and can be imported / exported as JSON.

**Also**: rename, delete, raw JSON view (`devices`, `devices:status`), and the CLI command log (click an entry to copy it).

## Where the templates come from

The templates are not hand-picked. They are generated from the SmartThings test fixtures of [Home Assistant](https://github.com/home-assistant/core) (`tests/components/smartthings/fixtures`, Apache-2.0, see [NOTICE](NOTICE)), which are dumps of real Samsung appliances. `tools/build-templates.py` extracts each model's components, capabilities and sample attribute values; the upstream commit is recorded in `templates/samsung-appliances.json`.

Each template has two profiles:

- **Standard capabilities only** (default): `switch`, `washerOperatingState`, `ovenMode`, `temperatureMeasurement` ... These are public SmartThings capabilities and work for any virtual device.
- **Full**: additionally includes the Samsung-specific capabilities the real device has (`custom.*`, `samsungce.*`, `hca.*`). Whether SmartThings accepts these in a virtual device profile depends on your account, and I could not verify it, so it is opt-in. If creation fails, use the standard profile. Run `npm run check-capabilities` to list which capabilities your account can see.

Plumbing capabilities of the real devices' cloud connection (`ocf`, `execute`, `logTrigger`, `demandResponseLoadControl`, `sec.*`) are always left out. After creating a device, **Load sample state** injects the values recorded from the real appliance. To regenerate the templates from a newer Home Assistant checkout, see the header of `tools/build-templates.py`.

## CLI commands used

| Action | Command |
| --- | --- |
| Locations / rooms | `smartthings locations`, `smartthings locations:rooms -l <locationId>` |
| List virtual devices | `smartthings virtualdevices [-l <locationId>]` |
| Device info / status | `smartthings devices <id>`, `smartthings devices:status <id>` |
| Capability definition | `smartthings capabilities <id> --capability-version 1` (CLI 1.x: `capabilities <id> 1`) |
| Create | `smartthings virtualdevices:create-standard -i input.json`, `smartthings virtualdevices:create -i input.json` |
| Inject events | `smartthings virtualdevices:events <id> -i input.json` |
| Rename / delete | `smartthings virtualdevices:update <id> -i input.json`, `smartthings virtualdevices:delete <id>` |

All commands are run with `--json` and parsed. The server detects the CLI version and adjusts arguments, so both CLI 1.10.x and 3.x work.

## Notes

- Virtual devices are created in the selected location of your real SmartThings account, so they also show up in the SmartThings app and in routines.
- Event injection targets cloud virtual devices. Hub-local virtual devices (`--local`) are not created by this UI.
- Reading status (`devices`, `devices:status`) works for any device id; all changes are restricted to virtual devices.

## License

MIT. See [LICENSE](LICENSE).
