# Components

A component is data on an actor or a blueprint. It is not a script. Play reads the data. The actor panel has a Components section: add, edit, and remove. The same four calls are on `MeshForge` and on the agent tool list.

`listComponents(id)`, `addComponent(id, component)`, `removeComponent(id, componentId)`, `setComponent(id, componentId, patch)`.

`id` is an actor or a blueprint. Placing a blueprint copies its components onto the new actor. Later edits to that actor stay on that actor. The project zip keeps them: actor components in `scene.json`, blueprint components in `scripts.json`.

## Types

| Type | What it stores | What Play does |
| --- | --- | --- |
| mesh | A shape name, an optional content-browser asset id, and visible | Records which mesh the actor uses. Hiding it hides the object. |
| collision | The existing collision preset, shape, and size | Writes through to the actor's collision. Removing it sets NoCollision. |
| material | A programmable material id and a state name | On Play, and when you edit it, emits `component:material`. A state such as `happy` can drive a face material that has that state. |
| behaviour | `wander`, `patrol`, `follow`, `face`, or `idle`, plus speed and a target or points | Moves or turns that actor while Play is running. Idle stays put. |
| brain | A short goal and a gap in seconds | While Play is running, asks the connected AI Agent provider for one command. The command has to be on the actor whitelist. |
| voice | Off unless you turn it on. Hear, speak, and a language | Web Speech input sends the transcript to `onHear`. `speechSynthesis` speaks lines when speak is on. Both emit `voice:hear` and `voice:speak`. |

Behaviours are data. They are not JavaScript. Wander walks toward a point on a circle around the spot Play started. Patrol walks a list of `[x, z]` points. Follow moves toward an actor id, a name, or the Character, and stops at `stop` metres. Face turns toward that target.

The brain may return `move`, `face`, `say`, `idle`, `setMaterialState`, `setMaterialParam`, `emit`, `transform_object`, `setCollision`, or `listActors`. Those run on that actor only. A payload with `code`, `source`, or `script` is refused. With no provider connected, the brain does nothing and the console says so.

Voice stays off until `enabled` is true. Browsers without the Web Speech API (anything but Chrome or Edge, typically) can still store the component. The microphone and the speaker are not started. Recognition runs only during Play.

## Events

`MeshForge.bus.on(name, fn)` and `MeshForge.bus.emit(name, data)` are the in-page bus. Materials and components use it. The programmable material core does not know the AI plugin's server address. Build with AI emits `ai:material`. The AI Agent plugin listens and calls its own backend. `MeshForge.materialEvents` is the same bus under the old name.

## Not in this version

An animation timeline and an armature fitter are not included. Companion drone and shooter or kiosk startup are on hold.

Voice in a real browser, a live AI provider, Windows, and a real GPU were not exercised here.
