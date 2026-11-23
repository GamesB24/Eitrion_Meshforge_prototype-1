# Programmable materials

A programmable material is a normal MeshForge material. It can go on any mesh, or on one material slot. It is not tied to a face, a screen, or a character.

## Add and assign

In the material library, **＋ Programmable** (Add New Material) creates one. The same assets are listed in the content browser under **Programmable**. Double-click a row or a swatch to open the editor. Drag the row onto an object, or onto selected faces in Edit Mode.

The editor is a resizable window. It keeps a text brief, reference images, a GLSL snippet, and the declared parameters. Images are stored inside the asset (and so inside the project). They are not written to a path outside it. **Apply** saves that onto the asset as one undo step. **Build with AI** only fills the window. **Regenerate** and the history list iterate on the current draft.

## What the AI is allowed to return

Build uses the AI Agent provider and the session key. The key is not stored on the asset. With no provider connected, the window says so, and the GLSL and parameters can still be edited by hand.

The model must return a spec, not a program:

- PBR values: colour, roughness, metalness, emissive colour, emissive strength, opacity
- Chibili values: bands, shadow tint, rim, softness
- a GLSL snippet compiled inside MeshForge's template
- a parameter list: name, type (`float`, `int`, `bool`, `color`, `vec2`, `vec3`, `texture`), range, default, label

The snippet assigns `mfAlbedo`, `mfRough`, `mfMetal`, `mfEmissive`, and `mfAlpha`. It can read `uTime`, `mfUV`, `vN`, `vW`, and `uP_<name>`. It cannot declare `main`, include files, or contain JavaScript. Compile errors are shown in the window. A snippet that fails to compile does not replace the last good viewport shader with random code; the slot shows an error colour until it compiles.

Declared parameters become sliders, colour pickers, or texture slots in the window and in the Details panel.

## Driving parameters

`uTime` is always available in the shader. A parameter can also be driven by time, by `setMaterialParam`, or later by a gameplay event. `MeshForge.materialEvents.emit(name, data)` is the hook. A parameter with drive `{ source: 'event', event: name }` reads `data.value`. A hook `{ event, state }` can switch to a named state.

States are named snapshots of the parameters, with an optional blend time. `setMaterialParam` and `setMaterialState` update the live look and do not push an undo step. `saveMaterialState` records a snapshot and is one undo step.

## UVs on a curved panel

Each slot can normalise its UV region to 0..1, correct aspect, and fall back to a planar projection from the average normal when UVs are missing or stretched. Planar is automatic unless it is set to off or forced on. The choices are in the editor and in the Details panel for the active slot.

## Presets and the test head

The library starts with four presets: Screen Face (eyes, mouth, blink, and the states neutral, happy, sad, surprised, angry, thinking, talking), Hologram, Flowing Water, and Animated Emissive Panel.

**Add ▸ MIT test head** builds a small original helmet: slightly wide, with a curved front panel inside a raised rim, two paddles on top, and round pods on the sides. The face panel is slot 2 and uses Screen Face.

## Agent API

All of these are whitelisted tools. Create, edit, and build are undoable. Live parameter and state changes are not.

`createProgrammableMaterial`, `editProgrammableMaterial`, `buildProgrammableMaterial`, `listMaterialParams(target)`, `setMaterialParam(target, name, value, {blendMs})`, `listMaterialStates(target)`, `setMaterialState(target, name, {blendMs})`, `saveMaterialState(target, name)`.

`target` is a material id or name, or an object id. The object's programmable slot is used when it has one.
