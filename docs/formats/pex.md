# Compiled Papyrus scripts (PEX)

Sources: UESP "Skyrim Mod:Compiled Script File Format", Champollion. Verified on all 14,302
scripts in the vanilla archives (`node tools/pex-dump.ts --verify`: 310,184 instructions,
none rejected, about 0.7 s).

## File

Skyrim's PEX files are **big-endian** (Fallout 4's are little-endian).

- u32 magic `0xFA57C0DE`, u8 major (3), u8 minor (1 or 2), u16 game id (1), u64 compile time,
  wstrings source file, user, machine (wstring = u16 length + bytes).
- String table: u16 count, wstrings. Every name and type below is a u16 index into it.
- Debug info: u8 flag; if set, u64 time and u16 count of (object, state, function name, u8
  function type, u16 n, n × u16 line numbers).
- User flags: u16 count of (name, u8 bit).
- Objects: u16 count; each a name, **u32 size** (counts itself and the rest of the object),
  parent class, doc string, u32 user flags, auto state name, then variables, properties and
  states (u16 counts). The parser checks the size.
  - Variable: name, type, u32 user flags, value.
  - Property: name, type, doc, u32 user flags, u8 flags (1 read, 2 write, 4 auto); auto
    properties name their variable, others have a getter and/or setter function.
  - State: name ("" is the default state), u16 count of named functions.
- Function: return type, doc, u32 user flags, u8 flags (1 global, 2 native), u16 params
  (name, type), u16 locals (name, type), u16 instructions.
- Value: u8 type: 0 None, 1 identifier (string index), 2 string (index), 3 i32, 4 f32, 5 u8 bool.
- Instruction: u8 opcode and its fixed arguments; `callmethod`, `callparent` and `callstatic`
  then have an integer value with the number of further arguments. Jump offsets are relative
  to the jump itself.

| op  | name                                         | args | op    | name                                        | args |
| --- | -------------------------------------------- | ---- | ----- | ------------------------------------------- | ---- |
| 0   | nop                                          | 0    | 18    | cmp_gt                                      | 3    |
| 1–9 | iadd fadd isub fsub imul fmul idiv fdiv imod | 3    | 19    | cmp_ge                                      | 3    |
| 10  | not                                          | 2    | 20    | jmp                                         | 1    |
| 11  | ineg                                         | 2    | 21–22 | jmpt jmpf                                   | 2    |
| 12  | fneg                                         | 2    | 23    | callmethod (name, self, dest, …)            | 3+   |
| 13  | assign                                       | 2    | 24    | callparent (name, dest, …)                  | 2+   |
| 14  | cast                                         | 2    | 25    | callstatic (script, name, dest, …)          | 3+   |
| 15  | cmp_eq                                       | 3    | 26    | return                                      | 1    |
| 16  | cmp_lt                                       | 3    | 27    | strcat                                      | 3    |
| 17  | cmp_le                                       | 3    | 28–29 | propget / propset (name, object, value)     | 3    |
|     |                                              |      | 30–35 | array_create, length, get, set, find, rfind | 2–4  |

## Runtime notes (`src/scripting/`)

- A cast converts to the **destination variable's declared type**; object casts check the
  form's native type chain (e.g. Actor → ObjectReference → Form) and its attached scripts.
- A child script's functions read the parent script's variables directly (e.g.
  `BYOHBuildingObjectInteriorScript` uses `::BYOHHouseBuilding_var` of
  `BYOHBuildingObjectScript`), so variables resolve through the whole chain.
- `GotoState` is compiled into each script: it assigns `::State` and calls
  `onEndState`/`onBeginState`; functions resolve in the current state first.
- Property values from VMAD are typed by the property's declared type.
- `Quest.SetStage` calls the native `SetCurrentStageID`; the VM host runs the stage's fragment
  (QUST VMAD) after marking it done. `GetStageDone` calls the native `IsStageDone`.
