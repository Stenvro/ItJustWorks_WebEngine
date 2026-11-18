// The game's console commands and script functions as the game registers them (observed in the
// original): each line is a command's name, its short name, its flags and its parameters. The
// console commands come first, in the game's order; the script functions follow in theirs, so
// that a script function's place among them is its condition function index (the CTDA function,
// src/scripting/condition-functions.ts). Flags: c a console command (help lists them apart), r a
// reference function (it acts on the reference before the dot, or the one selected), 0 its action
// returns at once (the command is accepted and does nothing: a tool of the game's makers left
// without its body), x it has no action (the console cannot run it: conditions only), k it has a
// condition function (what the console prints for it is that function's value). A parameter is
// its type (the game's script parameter types: src/shell/console-table.ts reads them), "?" when it
// may be left out, and the name the game's messages use. Platform-independent.

export const FUNCTION_TABLE = `
Show|TST|c|2:Float
ShowVars|SV|cr|
ShowGlobalVars|SGLV|c|
ShowQuestVars|SQV|c|14:Quest
ShowQuests|SQ|c|
ShowQuestAliases||c|14:Quest
SetPapyrusQuestVar|SETPQV|c|14:Quest,0:String,0:String
SetPapyrusVar|SETPV|c|0:String,0:String
SetQuestAliases||c|14:Quest
ClearQuestAliases||c|14:Quest
ToggleCombatStats|TCS|c|
ToggleSafeZone|TSZ|c0|
ToggleAI|TAI|c|6?:Actor (optional)
ToggleCollisionGeometry|TCG|c0|
ToggleMaterialGeometry|TMG|c0|
ToggleStairsGeometry|TSG|c0|
ToggleBorders|TB|c|
ToggleSky|TS|c|
ToggleWireframe|TWF|c|
ToggleCollision|TCL|c|
ToggleDebugText|TDT|c0|
ToggleMenus|TM|c|
TogglePrimitives|TPR|c0|
ShowScenegraph|SSG|c0|
ShowScenegraph|SFSG|c0|
ToggleMagicStats|TMS|c|
ShowAnim|SA|cr0|
Show1stPerson|S1ST|c|
Help||c|0?:String (Optional),1?:Integer (Optional),0?:String (Optional)
ToggleNavMesh|TNM|c0|1?:Integer (Optional)
TogglePathLine|TPL|c0|0?:String
PickRefByID|PRID|c|4?:ObjectReferenceID
SetLightingPasses|SLP|c0|0:String
ToggleLensFlare|LF|c|
SetLensFlareGlobalIntensity|LFI|c|2:Float
ToggleLODLand|TLL|c|0?:String (Optional),0?:String (Optional),0?:String (Optional),0?:String (Optional)
ToggleMapEffect|TME|c|0?:String
SetLODObjectDistance|SLOD|c|2:Float,2:Float,2:Float,2:Float
ToggleGrassUpdate|TGU|c0|
CenterOnCell|COC|c|0:String
CheckRenderTargets|CRT|c|
SetGameSetting|SetGS|c|0:String,0:String
SetINISetting|SetINI|c|0:String,0:String
GetINISetting|GetINI|c|0:String
CenterOnExterior|COE|c|1:Integer,1:Integer
CalcPathToPoint|P2P|cr0|
CalcLowPathToPoint|LP2P|cr|1:Integer,1:Integer,1:Integer
SetFog||c|1:Integer,1:Integer
SetClipDist||c|2:Float
ToggleShadowVolumes|TSV|c0|
SetImageSpaceGlow|SISG|c0|1:Integer,2:Float,2:Float,2:Float
ToggleDetection|TDETECT|c|
ToggleHighProcess|THIGHPROCESS|c|
ToggleLowProcess|TLOWPROCESS|c|
ToggleMiddleLowProcess|TMLOWPROCESS|c|
ToggleMiddleHighProcess|TMHIGHPROCESS|c|
ToggleAiSchedules|TAIS|c|
SpeakSound||cr|0:Filename,1?:Emotion,1?:EmotionValue
BetaComment|BC|c0|0:String
GameComment|GC|c0|0:String
ToggleCellNode|TCN|c|1:Integer
ToggleTrees|TT|c|
SetCameraFOV|FOV|c|2?:Float (Optional),2?:Float (Optional)
ToggleGodMode|TGM|c|
RefreshShaders|RS|c|0?:String
ReloadFXP|RFXP|c|0:String
ToggleScripts|TSCR|c|
ToggleConversations|TCONV|c|
ToggleFullHelp|TFH|c0|
ShowQuestLog|SQL|c|1?:Integer (Optional)
ShowFullQuestLog|SFQL|c|14:Quest
DumpTexturePalette|DTP|c0|0?:String
DumpModelMap|DMM|c|0?:String
CenterOnWorld|COW|c|27:WorldSpace,1:Cell X,1:Cell Y
ToggleGrass|TG|c|
CreateGrassAt|cga|c0|2:Float,2:Float
AddFaceAnimNote|AFAN|cr|0:String
RefreshINI|REFINI|c|
ToggleEmotions|temo|c|
AddDecal||c|
TestCode||c|2?:Float (Optional),2?:Float (Optional)
PlayerSpellBook|psb|c|
PrintAiList|pai|c0|
ShowQuestTargets|SQT|c|
HairTint||c0|1:Integer,1:Integer,1:Integer
SaveGame|save|c|0:String,1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
LoadGame|load|c|0:String,1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
DisplayPlayerIDs|dpid|c|
SetDisplayPlayerID|spid|c|0:String
TestAllCells|TAC|c0|1:Integer,1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),0?:String (Optional)
RenderTestCell|rtc|c|
RenderTestHere|rth|c|
SaveWorld||c|0:String
ReloadCurrentClimate|rcc|c|
ReloadCurrentWeather|rcw|c|
TestSeenData|tsd|c0|
TestLocalMap|tlm|c0|1:Integer
MoveToQuestTarget|movetoqt|c|14:Quest,1?:Integer (Optional)
PrintNPCDialog|pdialog|c|
ShowSubtitle||c|1?:Integer (Optional)
ShowRenderPasses|srp|c0|
FreezeRenderAccumulation|fra|c|
ToggleOcclusion|tocc|c|
OutputMemContexts|omc|c|0?:String
OutputMemStats|oms|c0|0?:String
SetMemCheckPoint|smcp|c0|1:Integer,0?:String (Optional)
GetMemCheckPoint|gmcp|c0|0?:String
IncMemCheckPoint|imcp|c0|0?:String
OutputAllocations|outalloc|c0|0:String,0?:String (Optional),1?:Integer (Optional),1?:Integer (Optional)
AddWatchAddress|awa|c0|0:String,1:Integer
RemoveWatchAddress|rwa|c0|0:String
ToggleDetectionStats|tds|c|6?:Actor (optional)
SetTargetRefraction|str|c|2:Float
SetTargetRefractionFire|strf|c0|2:Float,1:Int
ToggleRefractionDebug|trd|c|
ToggleCharControllerShape|TCCS|c|
ShowHeadTrackTarget|SHeadT|cr|
SetCinematicParam|SCP|c|2:Float,2:Float,2:Float
SetTintParam|STP|c|2:Float,2:Float,2:Float,2:Float
SetHDRParam|SHP|c|2:Float,2:Float,2:Float,2:Float,2:Float,2:Float,2:Float,2:Float,2:Float
VisualRefPosition|VRP|cr0|
ShowPivot|SP|cr0|
PrintHDRParam|PHP|c|
ToggleHDRDebug|THD|c0|
ToggleHDRMultipleLuminance|THML|c0|
RevertWorld|rw|c|
OutputArchiveProfile|oap|c|0?:String
QuitGame|qqq|c|
SaveIniFiles|saveini|c|
SetDebugText|sdt|c0|0?:String (Optional),1?:Integer (Optional)
ToggleLiteBrite|tlb|c|
RunMemoryPass|rmp|c0|1:Integer
ResetMemContexts|rmc|c|
ToggleWaterSystem|TWS|c|
ToggleWaterRadius|TWR|c|
ShowWhoDetectsPlayer|SWDP|c0|
ToggleCombatAI|tcai|c|
ToggleFlyCam|tfc|c|1?:Integer (Optional)
ModWaterShader|mws|c0|0:String,2?:Float(optional)
WaterColor|mwc|c0|1:Integer,2:Float,2:Float,2:Float
BeginTrace|bt|c0|
RunCellTest|rct|c|1?:Integer (Optional)
StartAllQuests|saq|c|
CompleteAllQuestStages|caqs|c|
ToggleFogOfWar|TFOW|c|
OutputLocalMapPictures|OLMP|c0|
SetGamma|sg|c|2:Float
WasteMemory|wm|c|2:Float
ClearAdaptedLight|cal|c|
SetHudGlowConstants|shgc|c0|2?:Float (Optional),2?:Float (Optional),2?:Float (Optional),2?:Float (Optional)
CloseFile||c|0:String
SetTreeMipmapBias|stmb|c|2?:Float (Optional),2?:Float (Optional)
SendSherlockDebugText|ssdt|c0|0?:String
PlayExplosion||c|
SetMaxAniso|sma|c|2:Float
SetMeshLODLevel|smll|c|2:Float
SetTargetDOF|stdof|c|
ToggleFullScreenMotionBlur|tfsmb|c0|
SetTriLinearThreshold|stlt|c|2:Float
SetVel||cr|8:Axis,2:Float
DebugCombatBehavior|dcb|cr|
ToggleCombatDebug|tcd|c|0?:String
TogglePathingInfoFunction|TPI|c0|
ShowInventory|inv|c|
ResetPerformanceTimers|rpt|c0|
ToggleDebugDecal|TDD|c0|1:Integer
ToggleDecalRendering|TDR|c|
SetImageSpaceModifiersEnable|sisme|c|1:Integer
SetUFOCamSpeedMult|sucsm|c|2:Float
ToggleTestLight|TTL|c|1?:Integer (Optional),2?:Float (Optional),2?:Float (Optional)
PlaceLocationMarker|plm|c|2:X,2:Y,2:Z,0?:Name ( Optional ),1?:Color ( Optional )
ClearLocationMarkers|clm|c|
ToggleMultiboundCheck|mbc|c0|
AddOcclusionPlane|AOP|c|2?:Float (Optional),2?:Float (Optional)
SetGlobalRadialBlur|sgrb|c|2:Float,2:Float,2:Float,2:Float,2:Float
OutputTextureUseMap|OTUM|c|0?:String
ClearScreenBlood|csb|c|
ResetDialogueFlags|rdf|c|
GetActorValueInfo|GetAVInfo|cr|5:Actor Value
ToggleBoundVisGeom|tbvg|c0|
SetConsoleOuputFile|scof|c|0:String
IgnoreRenderPass|irp|c0|1?:Integer (Optional),1?:Integer (Optional)
PlayVATSCameras|pvc|c|0:String
SetTargetFalloff|stfo|c|2?:Float (Optional),2?:Float (Optional),2?:Float (Optional),2?:Float (Optional)
ToggleActorMover|tam|c0|
CopySaves|CopySaves|c|0?:String
ToggleEOFImageSpace|teofis|c|
ForceFileCache|ffc|c0|
DumpNiUpdates|dnu|c|
TestDegrade||c0|1:Integer
ToggleDepthBias|tdb|c|
ToggleSPURenderBatch|tSPURB|c0|
ToggleSPUTransformUpdate|tSPUTU|c0|
ToggleSPUCulling|tSPUC|c0|
ModifyFaceGen|mfg|c|0:String,1?:Integer (Optional),1?:Integer (Optional)
ForceRSXCrash|fRSX|c0|
SetEmitterParticleMax||c|1:Integer
SetMPSParticleMax||c|1:Integer
SetTaskThreadSleep||c|1:Integer
SetTaskThreadUpdateSleep||c|1:Integer
EvalActorTextures|EAT|c0|
CreateSaveData|createsaves|c0|1:Integer,1:Integer
CreateGameData||c0|0:String,1?:Integer (Optional)
LoadFlashMovie||c|0:String
ShowMenu||c|0:String
HideMenu||c|0:String
RecvAnimEvent|rae|cr|0:String,0?:String
RunConsoleBatch|bat|c|0:String
LTGraph|LTGraph|c|0:String
RTGraph|RTGraph|c|0:String
ToggleHeapTracking|THT|c0|
TogglePoolTracking|TPT|c0|
RumbleManager|RM|c|2?:Float (Optional),2?:Float (Optional),2?:Float (Optional),2?:Float (Optional)
InstallMemoryTracker|IMT|c0|0:String
UninstallMemoryTracker|UMT|c0|
CheckMemory|chkmem|c0|
SetStackDepth|SSD|c0|1:Integer
PathToRef|PTR|cr|4?:TESObjectREFR
StartAIControlledRobotTest|SPTP|c0|0:String,0:String,0?:String(optional)
TestHandleManagerWarnAndKillSDM|THMWAKS|c0|
SetFaceTarget|SFT|cr|4?:TESObjectREFR
PrecomputedLOSGeneration|plg|c|0?:String (Optional),0?:String (Optional),0?:String (Optional)
PrecomputedLOSDebug|pld|c|0?:String (Optional),0?:String (Optional),0?:String (Optional)
SetPathSprinting|SPS|cr|1:Integer
SetAnimGraphVar|sgv|cr|0:String,0:String,0?:String(optional),0?:String(optional),0?:String(optional)
SetTreeTrunkFlexibility|STSTF|c|2:Float
SetTreeBranchFlexibility|STSBF|c|2:Float
SetTreeBranchAnimationRange|STSBR|c|1:Integer,1:Integer
SetTreeLeafFlexibility|STSLF|c|2:Float
SetTreeLeafAmplitude|STSLAMP|c|2:Float
SetTreeLeafFrequency|STSLFRQ|c|2:Float
SetTreeWindDirection|STSWD|c|2:Float,2:Float
SetTreeWindMagnitude|STSWM|c|2:Float
SetBloodParam|SBP|c|0:String,2?:Float(optional)
RegisterPrefix|RPRFX|c|0:String
ToggleEventLog|TEL|c0|
ExportPerfTrackingData|EPTD|c0|
DisplayGraphVariable|dgv|c0|0:String
ToggleMotionDriven|TMD|cr|1?:Integer (Optional)
ToggleControlsDriven|TC|cr|1?:Integer (Optional)
ToggleGUIOverlay|TGO|c0|
ModifyGUIOverlay|MGO|c0|0:String,0?:String (Optional),1?:Integer (Optional),1?:Integer (Optional)
SetActionComplete|SAC|cr0|
SetConsoleScopeQuest|SSQ|c|14?:Quest
GetDistanceFromActorsPath|GDFAP|c|4:TESObjectREFR
ClearConsole|clear|c0|
ToggleMarkers|TMK|c0|
KillAllProjectiles|kap|c0|
PlayTerrainEffect|PTFX|c|0:String
CellInfo||c0|
Textures|tx|c0|
Timing|FPS|c0|
Polygons|Polys|c0|
Actors|Actors|c0|
Quest|Quest|c0|
Particles|Particles|c0|
Memory||c0|
ShowNodes||cr0|0?:String
SaveDebugTextPages|SaveDTP|c0|
OutputFixedStringTable|OFST|c0|
AttachPapyrusScript|APS|c|0:String,0?:String
SaveHavokSnapshot|SHS|c|0:String,1?:Integer (Optional)
SetNPCWeight|SNPCW|cr|2:Float
ShowClosestLocationForSphere|SCLFS|c0|2:Float,2:Float,1:Int
PrintShaderMacros|PSM|c0|0:String,0:String
ToggleAudioOverlay|TAO|c0|
TogglePapyrusLog|TPLog|c0|
ToggleContextOverlay|TCO|c0|
ForceOutOfMemory|FOOM|c0|
ToggleMovement|TMOVE|c|
ToggleAnimations|TANIM|c|
SetWarning||c0|0:String,1?:Integer (Optional)
TestFadeNodes|TestFN|c0|
ShowLowMaxHeights|slmh|c|1:Integer,1?:Integer (Optional)
ShowHighMaxHeights|shmh|c|1:Integer
EnableStoryManagerLogging|esml|c|0?:String
SetFramebufferRange|sfbr|c|2:Float
DumpPapyrusStacks|dps|c|
DumpPapyrusUpdates|dpu|c|
SoundCatMod|scm|c0|79:SoundCategory,0:String,2?:Float(optional)
RunCompaction|rcmpct|c|
ToggleAnimatorCam|animcam|c|
ToggleImmortalMode|TIM|c|
SetSubgraphToDebug|sgd|c0|1:Integer
EnableRumble||c|1:Integer
HavokVDBCapture|vdbcapture|c0|0:String,1?:Integer (Optional)
ToggleMapCam|tmc|c0|
ToggleNavmeshInfo|tni|c0|
PlaySyncAnim|syncanim|cr|0:String,4?:ObjectReferenceID
SetFormKnown||c|0:String,1:Integer
SetDebugQuest||c|14:Quest,1:Integer,1:State
SetQuestAliasLogging|sqal|c|14:Quest,1:Integer
SetRace||c|0:String
FindForm|find|c|0:String,0?:String
StartPapyrusScriptProfile|StartPSP|c|0:String
StopPapyrusScriptProfile|StopPSP|c|0:String
StartPapyrusFormProfile|StartPFP|c|62:Form
StopPapyrusFormProfile|StopPFP|c|62:Form
PrintQuestSceneInfo|PrintS|c|14:Quest
IsInvulnerable|isinv|cr0|
ExportInventoryItemInfo|eiii|c0|1:Integer
CollisionMesh|colmesh|c0|
IsolateRendering|ir|c|
ToggleWaterCurrentGeometry|twcg|c0|1:Integer
PerformAction|pa|cr|83:Action
StartTrackPlayerDoors|StartTPD|c0|
StopTrackPlayerDoors|StopTPD|c0|
CheckPlayerDoors|CheckPD|c0|1?:Integer (Optional)
ToggleSPUMovement|tSPUM|c0|
SetInChargen||c|1:Integer,1:Integer,1:Integer
ClearAchievement||c0|1:Integer
ForceReset||c|
ReloadScript||c|0:String
ForceCloseFiles|FCF|c|
HotLoadPlugin|HLP|c|0:String
ToggleVerletDebug|tvd|c0|
DumpConditionFunctions||c0|
PlaceFurnitureTester|PFT|c|21?:ObjectID
DumpLoadedAnimationFiles||c0|
FunctionDisplayRenderTarget|drt|c|0?:String
ToggleParallaxOcclusion|tpo|c|
ToggleProjectedUVDiffuseNormals|tpuvdn|c|
ReloadProjectedUVTextures|rpuv|c|
FunctionToggleDownsampleCS|tdscs|c|
FunctionToggleVolumetricLighting|tscf|c|
FunctionToggleVolumetricLighting|tvl|c|
FunctionToggleVolumetricLightingTemporalAccumulation|tvla|c|
FunctionSetVolumetricLightingParameters|svlp|c|0:String,2:Float,2?:Float (Optional),2?:Float (Optional)
FunctionPrintVolumetricLightingParameters|pvlp|c|
FunctionSetVolumetricLightingResolution|svlr|c0|1:Integer
ToggleCastShadows|tsh|c|0?:String
SetShadowParameter|sh|c0|0:String,2?:Float(optional)
SetESRAMSetup|esram|c|1:Integer
ToggleESRAM|tesram|c|
ToggleMTR|tMTR|c|0?:String,0?:String (Optional)
ToggleHTile|tHTile|c|
ToggleZPrepassOutput|tZPO|c|0?:String
ToggleFXAA|tfxaa|c|
SetJobListBatch|jobb|c0|0?:String (Optional),1?:Integer (Optional)
SetJobListThread|jobt|c0|0?:String (Optional),1?:Integer (Optional)
JobListTool|jobc|c0|0:String,1:Integer
SetCullingProcessCount|cpc|c0|1:Integer
GetWantBlocking||rk|
GetDistance||rk|4:ObjectReferenceID
AddItem||r|53:ObjectID,1:Count,1?:Flag (Optional)
SetEssential|||25:Actor Base,1?:Integer (Optional)
Rotate||r|8:Axis,1:Speed
GetLocked||rk|
GetPos||rk|8:Axis
SetPos||r|8:Axis,2:Float
GetAngle||rk|8:Axis
SetAngle||r|8:Axis,2:Float
GetStartingPos||rk|8:Axis
GetStartingAngle||rk|8:Axis
GetSecondsPassed||k|
Activate||r|4?:ObjectReferenceID,1?:Integer (Optional)
GetActorValue|GetAV|rk|5:Actor Value
SetActorValue|SetAV|r|5:Actor Value,2:Amount
ModActorValue|ModAV|r|5:Actor Value,2:Amount
SetAtStart||r|
GetCurrentTime||k|
PlayGroup||r|10:Animation Group,1:Flags
LoopGroup||r|10:Animation Group,1:Integer,1:Flags
SkipAnim||r0|
StartCombat||r|6:Actor
StopCombat||r|
GetScale||rk|
IsMoving||rk|
IsTurning||rk|
GetLineOfSight|GetLOS|rk|4:ObjectReferenceID
AddSpell||r|7:Spell Item
RemoveSpell||r|7:Spell Item
Cast||r|11:Magic Item,4:ObjectReferenceID,68:Source (Optional)
GetButtonPressed|||
GetInSameCell||rk|4:ObjectReferenceID
Enable||r|1?:Integer (Optional)
Disable||r|1?:Integer (Optional)
GetDisabled||rk|
MenuMode||k|1?:Integer (Optional)
PlaceAtMe||r|21:ObjectID,1?:Count,1?:Distance,1?:Direction
PlaySound|||12:Sound,1?:Integer (Optional)
GetDisease||rk|
FailAllObjectives|||14:Quest
GetClothingValue||rk|
SameFaction||rk|6:Actor
SameRace||rk|6:Actor
SameSex||rk|6:Actor
GetDetected||rk|6:Actor
GetDead||rk|
GetItemCount||rk|53:ObjectID
GetGold||rk|
GetSleeping||rk|
GetTalkedToPC||rk|
Say||r|13:Topic,1?:Integer (Optional),25?:Actor Base,1?:Integer (Optional),1?:Integer (Optional)
SayTo||r|6:Actor,13:Topic,1?:Integer (Optional),1?:Integer (Optional)
GetScriptVariable||xk|4:ObjectReferenceID,22:Variable Name
StartQuest|||14:Quest
StopQuest|||14:Quest
GetQuestRunning|GetQR|k|14:Quest
SetStage|||14:Quest,23:Stage
GetStage||k|14:Quest
GetStageDone||k|14:Quest,23:Stage
GetFactionRankDifference||rk|17:Faction,6:Actor
GetAlarmed||rk|
IsRaining||k|
GetAttacked||rk|
GetIsCreature||rk|
GetLockLevel||rk|
GetShouldAttack||rk|6:Actor
GetInCell||rk|9:Cell
GetIsClass||rk|16:Class
GetIsRace||rk|15:Race
GetIsSex||rk|18:Sex
GetInFaction||rk|17:Faction
GetIsID||rk|21:ObjectID
GetFactionRank||rk|17:Faction
GetGlobalValue||k|19:Global
IsSnowing||k|
FastTravel|ft||4:TESObjectREFR
GetRandomPercent||k|
RemoveMusic|||57:Music
GetQuestVariable||xk|14:Quest,22:Variable Name
GetLevel||rk|
IsRotating||rk|
RemoveItem||r|53:ObjectID,1:Count,1?:Flag (Optional)
GetLeveledEncounterValue||r|1:Integer
GetDeadCount||k|25:Actor Base
AddToMap|ShowMap||24:Map Marker,1?:Integer (Optional)
StartConversation||r|4:TESObjectREFR,13?:Topic,4?:TESObjectREFR,4?:TESObjectREFR,1?:Integer (Optional),1?:Integer (Optional)
Drop||r|3:ObjectID,1:Count
AddTopic|||13:Topic
ShowMessage|||52:Message
SetAlert||r|1:Integer
GetIsAlerted||rk|
Look||r|4:ObjectReferenceID,1?:Integer (Optional)
StopLook||r|
EvaluatePackage|evp|r|
SendAssaultAlarm|||6?:Actor (optional),17?:Faction (Optional)
EnablePlayerControls|epc||1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
DisablePlayerControls|dpc||1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
GetPlayerControlsDisabled|gpc|k|1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
GetHeadingAngle||rk|4:ObjectReferenceID
PickIdle||r|
IsWeaponMagicOut||rk|
IsTorchOut||rk|
IsShieldOut||rk|
CreateDetectionEvent||r|4:TESObjectREFR,1:Integer
IsActionRef||r|4:ObjectReferenceID
IsFacingUp||rk|
GetKnockedState||rk|
GetWeaponAnimType||rk|
IsWeaponSkillType||rk|5:Actor Value
GetCurrentAIPackage||rk|
IsWaiting||rk|
IsIdlePlaying||rk|
CompleteQuest|||14:Quest
Lock||r|1?:Integer (Optional),1?:Integer (Optional)
UnLock||r|1?:Integer (Optional)
IsIntimidatedbyPlayer||rk|
IsPlayerInRegion||k|82:Region
GetActorAggroRadiusViolated||rk|
GetCrimeKnown||r|28:Crime Type,6:Criminal,6:Victim
SetEnemy|||17:Faction,17:Faction,1?:Value(Optional),1?:Value(Optional)
SetAlly|||17:Faction,17:Faction,1?:Value(Optional),1?:Value(Optional)
GetCrime||rk|6:Actor,28?:Crime Type (optional)
IsGreetingPlayer||rk|
StartMisterSandMan||r|6:Actor
IsGuard||rk|
StartCannibal||r|6:Actor
HasBeenEaten||rk|
GetStaminaPercentage|GetStamina|rk|
GetPCIsClass||k|16:Class
GetPCIsRace||k|15:Race
GetPCIsSex||k|18:Sex
GetPCInFaction||k|17:Faction
SameFactionAsPC||rk|
SameRaceAsPC||rk|
SameSexAsPC||rk|
GetIsReference||rk|4:ObjectReferenceID
SetFactionRank||r|17:Faction,1:Value
ModFactionRank||r|17:Faction,1:Value
KillActor|kill|r|6?:Actor (optional),1?:Integer (Optional),1?:Integer (Optional)
ResurrectActor|resurrect|r|1?:Integer (Optional)
IsTalking||rk|
GetWalkSpeed|GetWalk|rk|
GetCurrentAIProcedure||rk|
GetTrespassWarningLevel||rk|
IsTrespassing||rk|
IsInMyOwnedCell||rk|
GetWindSpeed||k|
GetCurrentWeatherPercent|getweatherpct|k|
GetIsCurrentWeather|getweather|k|33:Weather ID
IsContinuingPackagePCNear||rk|
SetCrimeFaction||r|17:Faction
GetIsCrimeFaction||rk|17:Faction
CanHaveFlames||rk|
HasFlames||rk|
AddFlames||r|
RemoveFlames||r|
GetOpenState||rk|
MoveToMarker|MoveTo|r|4:ObjectReferenceID,2?:Float (Optional),2?:Float (Optional),2?:Float (Optional)
GetSitting||rk|
GetFurnitureMarkerID||rx|
GetIsCurrentPackage||rk|29:Package
IsCurrentFurnitureRef||rk|4:ObjectReferenceID
IsCurrentFurnitureObj||rk|20:Furniture
SetSize|CSize|r|2:Float
RemoveMe||r|26?:Container (optional)
DropMe||r|
GetFactionReaction|||17:Faction,17:Faction
SetFactionReaction|||17:Faction,17:Faction,1:Value
ModFactionReaction|||17:Faction,17:Faction,1:Value
GetDayOfWeek||k|
IgnoreCrime||r0|1:Integer
GetTalkedToPCParam||k|6:Actor
RemoveAllItems||r|26?:Container (optional),1?:Ownership Added (optional),1?:No Message Flag (optional)
WakeUpPC|||1?:Integer (Optional)
IsPCSleeping||k|
IsPCAMurderer||k|
SetCombatStyle|setcs|r|30?:Combat Style (optional)
PlaySound3D|||12:Sound
SelectPlayerSpell|spspell||7:Spell Item,68:Casting Source
HasSameEditorLocAsRef||rk|4:TESObjectREFR,59?:Keyword
HasSameEditorLocAsRefAlias||rk|63:QuestAlias,59?:Keyword
GetEquipped||rk|53:ObjectID
Wait||r|29:Package
StopWaiting||r|29:Package
IsSwimming||rk|
ScriptEffectElapsedSeconds|||
SetCellPublicFlag|setpublic||9:Cell,1:Flag
GetPCSleepHours|||
SetPCSleepHours|||1:Integer
GetAmountSoldStolen||k|
ModAmountSoldStolen|||1:Integer
GetIgnoreCrime||k|
GetPCExpelled||k|17:Faction
SetPCExpelled|||17:Faction,1:Value
GetPCFactionMurder||k|17:Faction
SetPCFactionMurder|||17:Faction,1:Value
GetPCEnemyofFaction||k|17:Faction
SetPCEnemyofFaction|||17:Faction,1:Value
GetPCFactionAttack||k|17:Faction
SetPCFactionAttack|||17:Faction,1:Value
StartScene|||67:Scene
StopScene|||67:Scene
GetDestroyed||rk|
SetDestroyed||r|1:Integer
GetActionRef|getAR|r|
GetSelf|this|r|
GetContainer||r|
GetForceRun||r|
SetForceRun||r|1:Integer
GetForceSneak||r|
SetForceSneak||r|1:Integer
AdvancePCSkill|AdvSkill||5:Actor Value,2:Amount
AdvancePCLevel|AdvLevel||
HasMagicEffect||rk|31:Magic Effect
GetDefaultOpen||rk|
SetDefaultOpen||r|1:Integer
ShowClassMenu||0|
ShowRaceMenu|SetPlayerRace||15?:Race (optional)
GetAnimAction||rk|
ShowNameMenu||0|
SetOpenState||r|1:Integer
ResetReference|RecycleActor|r|4?:ObjectReferenceID
IsSpellTarget||rk|11:Magic Item
GetVATSMode||k|
GetPersuasionNumber||k|
GetVampireFeed||rk|
GetCannibal||rk|
GetIsClassDefault||0k|16:Class
GetClassDefaultMatch||0k|
GetInCellParam||k|9:Cell,4:ObjectReferenceID
UnusedFunction1||x|
GetCombatTarget||r|
GetPackageTarget||r|
ShowSpellMaking||0|
GetVatsTargetHeight||k|
SetGhost||r|1:Integer
GetIsGhost||rk|
EquipItem|EquipObject|r|3:ObjectID,1?:Flag,68?:Hand (Optional)
UnequipItem|UnEquipObject|r|3:ObjectID,1?:Flag,68?:Hand (Optional)
SetClass||r|16:Class
SetUnconscious|||1:Integer
GetUnconscious||rk|
SetRestrained|||1:Integer
GetRestrained||rk|
ForceFlee|Flee|r|9?:Cell (optional),4?:ObjectReferenceID (optional)
GetIsUsedItem||k|56:ObjectID
GetIsUsedItemType||k|32:Form Type
IsScenePlaying||k|67:Scene
IsInDialogueWithPlayer||rk|
GetLocationCleared||k|61:Location
SetLocationCleared|||61:Location,1:Integer
ForceRefIntoAlias||r|63:QuestAlias
EmptyRefAlias|||63:QuestAlias
GetIsPlayableRace||rk|
GetOffersServicesNow||rk|
GetGameSetting|GetGS||0:String
StopCombatAlarmOnActor|SCAOnActor|r|
HasAssociationType||rk|6:Actor,69:AssociationType
HasFamilyRelationship|Family|rk|6:Actor
SetWeather|sw||33:Weather ID,1?:Integer (Optional)
HasParentRelationship|IsParent|rk|6:Actor
IsWarningAbout||rk|37:Form List
IsWeaponOut||rk|
HasSpell||rk|7:Spell Item
IsTimePassing||k|
IsPleasant||k|
IsCloudy||k|
TrapUpdate||0|
ShowQuestObjectives|SQO||14?:Quest
ForceActorValue|ForceAV|r|5:Actor Value,2:Amount
IncrementPCSkill|IncPCS||5:Actor Value
DoTrap||r|4:Trap,2:Damage,2:Lev. Damage,2:Pushback,2:Death Pushback,2:Min. Velocity,1:Continuous,2:Stagger
EnableFastTravel|EnableFast||1:Integer
IsSmallBump||rk|
GetParentRef||r|
PlayBink|||0:String,1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
GetBaseActorValue|GetBaseAV|rk|5:Actor Value
IsOwner||rk|35?:Owner(optional)
SetOwnership||r|35?:Owner(optional)
IsCellOwner||rk|9:Cell,35?:Owner(optional)
SetCellOwnership|||9:Cell,35?:Owner(optional)
IsHorseStolen||rk|
SetCellFullName|||9:Cell,52:Message
SetActorFullName||r|52:Message
IsLeftUp||rk|
IsSneaking||rk|
IsRunning||rk|
GetFriendHit||rk|
IsInCombat||rk|1?:Integer (Optional)
SetPackDuration|SPDur|r|2:Float
PlayMagicShaderVisuals|PMS|r|36:Effect Shader ID,2?:Time(optional)
PlayMagicEffectVisuals|PME|r|31:Magic Effect,2?:Time(optional)
StopMagicShaderVisuals|SMS|r|36:Effect Shader ID
StopMagicEffectVisuals|SME|r|31:Magic Effect
ResetInterior|||9:Cell
IsAnimPlaying||r|10?:Animation Group
SetActorAlpha|SAA|r|2:Float,1?:Int(optional)
EnableLinkedPathPoints||r0|
DisableLinkedPathPoints||r0|
IsInInterior||rk|
ForceWeather|fw||33:Weather ID,1?:Integer (Optional)
ToggleActorsAI||r|
IsActorsAIOff||r|
IsWaterObject||rk|
GetPlayerAction||rk|
IsActorUsingATorch||rk|
SetLevel||r|1:Integer,1?:Integer (Optional),1?:Integer (Optional),1?:Integer (Optional)
ResetFallDamageTimer||r|
IsXBox||k|
GetInWorldspace||rk|27:WorldSpace
ModPCMiscStat|ModPCMS||0:String,1:Integer
GetPCMiscStat|GetPCMS|k|41:Miscellaneous Stat
GetPairedAnimation|GPA|rk|
IsActorAVictim||rk|
GetTotalPersuasionNumber||k|
SetScale||r|2:Float
ModScale||r|2:Float
GetIdleDoneOnce||k|
KillAllActors|killall||6?:Actor (optional)
GetNoRumors||rk|
SetNoRumors||r|1:Integer
Dispel||r|11:Magic Item
GetCombatState||rk|
TriggerHitShader|ths||2?:Float (Optional)
GetWithinPackageLocation||rk|78:PackageData (Location)
Reset3DState|||
IsRidingMount||rk|
DispelAllSpells||r|
IsFleeing||rk|
AddAchievement||0|1:Integer
DuplicateAllItems||r|26?:Container (optional),1?:Ownership Added (optional)
IsInDangerousWater||rk|
EssentialDeathReload|||0:String
SetShowQuestItems|||1:Integer
DuplicateNPCStats||r|6?:Actor (optional)
ResetHealth||r|
SetIgnoreFriendlyHits|sifh|r|1:Integer
GetIgnoreFriendlyHits|gifh|rk|
IsPlayersLastRiddenMount||rk|
SetActorRefraction|sar|r|2:Float
SetItemValue||r|1:Integer
SetRigidBodyMass|||2:Float
ShowViewerStrings|svs|r0|
ReleaseWeatherOverride|rwo||
SetAllReachable|||1:Integer
SetAllVisible|||1:Integer
SetNoAvoidance|||1:Integer
SendTrespassAlarm||r|6:Actor
SetSceneIsComplex|||1:Integer
Autosave|||
StartMasterFileSeekData||0|
DumpMasterFileSeekData||0|
IsActor||rk|
IsEssential||rk|
PreloadMagicEffect||r|31:Magic Effect
ShowDialogSubtitles|||1?:Integer (Optional)
SetPlayerResistingArrest||r|
IsPlayerMovingIntoNewSpace||k|
GetInCurrentLoc||rk|61:Location
GetInCurrentLocAlias||rk|63:QuestAlias
GetTimeDead||rk|
HasLinkedRef||rk|59?:Keyword
GetLinkedRef||r|59?:Keyword
DamageObject|do|r|2:Float
IsChild||rk|
GetStolenItemValueNoCrime||k|17:Faction
GetLastPlayerAction||k|
IsPlayerActionActive||k|1:Integer
SetTalkingActivatorActor||r|6?:Actor (optional)
IsTalkingActivatorActor||rk|6:Actor
ShowBarterMenu|sbm|r|1?:Integer (Optional)
IsInList||rk|37:Form List
GetStolenItemValue||k|17:Faction
AddPerk||r|39:Perk
GetCrimeGoldViolent|getviolent|rk|17?:Faction (Optional)
GetCrimeGoldNonviolent|getnonviolent|rk|17?:Faction (Optional)
ShowRepairMenu|srm|0|
HasShout||rk|64:Shout
AddNote|AN||40:Note
RemoveNote|RN||40:Note
GetHasNote|GetN|k|40:Note
AddToFaction|Addfac|r|17:Faction,1:Value
RemoveFromFaction|Removefac|r|17:Faction
DamageActorValue|DamageAV|r|5:Actor Value,2:Amount
RestoreActorValue|RestoreAV|r|5:Actor Value,2:Amount
TriggerHUDShudder|hudsh|0|2?:Float (Optional),2?:Float (Optional),2?:Float (Optional),2?:Float (Optional)
GetObjectiveFailed|||14:Quest,1:Integer
SetObjectiveFailed|||14:Quest,1:Integer,1:State
SetGlobalTimeMultiplier|sgtm||2:Float
GetHitLocation||rk|
IsPC1stPerson|pc1st|k|
PurgeCellBuffers|pcb||
PushActorAway||r|4:ObjectReferenceID,1:Integer
SetActorsAI||r|1:Integer
ClearOwnership||r|
GetCauseofDeath||rk|
IsLimbGone||rk|1:Integer
IsWeaponInList||rk|37:Form List
PlayIdle||r|0:String,4?:ObjectReferenceID
ApplyImageSpaceModifier|imod||42:Imagespace Modifier ID,2?:Float (Optional)
RemoveImageSpaceModifier|rimod||42:Imagespace Modifier ID,2?:Float (Optional)
IsBribedbyPlayer||rk|
GetRelationshipRank||rk|6:Actor
SetRelationshipRank||r|6:Actor,1:Value
SetCellImageSpace|||9:Cell,43:ImageSpace
ShowChargenMenu|scgm|0|
GetVATSValue||k|1:Integer,1?:Integer (Optional)
IsKiller||rk|6:Actor
IsKillerObject||rk|37:Form List
GetFactionCombatReaction||k|17:Faction,17:Faction
UseWeapon||r|21:Weapon,4:Location,4:Target,1:NumAttacks,1?:CrouchToReload,1?:HoldFire,1?:AlwaysHit,1?:DoNoDamage,4?:TargetLocation
EvaluateSpellConditions|esc|r|
ToggleMotionBlur|tmb||
Exists||rk|4:ObjectReferenceID
GetGroupMemberCount||rk|
GetGroupTargetCount||rk|
SetObjectiveCompleted|||14:Quest,1:Integer,1:State
SetObjectiveDisplayed|||14:Quest,1:Integer,1:State
GetObjectiveCompleted|||14:Quest,1:Integer
GetObjectiveDisplayed|||14:Quest,1:Integer
SetImageSpace|||43?:ImageSpace
PipboyRadio|prad||0:String,4?:ObjectReferenceID
RemovePerk||r|39:Perk
DisableAllActors|DisAA|r|
GetIsFormType||r|0:String
GetIsVoiceType||rk|49:VoiceType
GetPlantedExplosive||rk|
CompleteAllObjectives|||14:Quest
IsScenePackageRunning||rk|
GetHealthPercentage||rk|
SetAudioMultithreading|SAM||1:Integer
GetIsObjectType||rk|32:Form Type
ShowChargenMenuParams|scgmp|0|1:Integer,1:Integer,1:Integer
GetDialogueEmotion||rk|
GetDialogueEmotionValue||rk|
ExitGame|exit||
GetIsCreatureType||rk|1:Integer
PlayerCreatePotion|||31:Magic Effect,31?:Magic Effect,31?:Magic Effect
PlayerEnchantObject|||21:Object,31:Magic Effect,31?:Magic Effect
ShowWarning|||0:String
EnterTrigger||r|4:ObjectReferenceID
MarkForDelete||r|
SetPlayerAIDriven|||1:Integer
GetInCurrentLocFormList||rk|37:Form List
GetInZone||rk|50:EncounterZone
GetVelocity||rk|8:Axis
GetGraphVariableFloat||rk|0:String
HasPerk||rk|39:Perk
GetFactionRelation||rk|6:Actor
IsLastIdlePlayed||rk|51:Idle Form
SetNPCRadio|snr||1:Integer,4:ObjectReferenceID
SetPlayerTeammate||r|1:Integer
GetPlayerTeammate||rk|
GetPlayerTeammateCount||k|
OpenActorContainer||r|1?:Integer (Optional)
ClearFactionPlayerEnemyFlag|||17:Faction
ClearActorsFactionsPlayerEnemyFlag||r|
GetActorCrimePlayerEnemy||rk|
GetCrimeGold||rk|17?:Faction (Optional)
SetCrimeGold||r|1:Integer,17?:Faction (Optional)
ModCrimeGold||r|1:Integer,1?:Integer (Optional),17?:Faction (Optional)
GetPlayerGrabbedRef|||
IsPlayerGrabbedRef||k|4:TESObjectREFR
PlaceLeveledActorAtMe|||21:ObjectID,1?:LevelModifier,50?:ForcedZone
GetKeywordItemCount||rk|59:Keyword
ShowLockpickMenu|slpm||1?:Integer (Optional)
GetBroadcastState||r0|
SetBroadcastState||r|1:Integer
StartRadioConversation||r|13?:Topic
GetDestructionStage||rk|
ClearDestruction||r|
CastImmediateOnSelf|cios|r|11:Magic Item
GetIsAlignment||rk|54:Alignment
ResetQuest|||14:Quest
SetQuestDelay|||14:Quest,2:Float
IsProtected||rk|
GetThreatRatio||rk|6:Actor
MatchFaceGeometry||r|6:Actor,1:Value
GetIsUsedItemEquipType||rk|55:EquipType
GetPlayerName||0|
FireWeapon||r|21:Weapon
PayCrimeGold||r|1?:Integer (Optional),1?:Integer (Optional),17?:Faction (Optional)
UnusedFunction2||rx|2:Float
MatchRace||r|6:Actor
SetPCYoung|||1:Integer
SexChange|||18?:Sex,1?:Integer (Optional)
IsCarryable||rk|
GetConcussed||rk|
SetZoneRespawns|||50:EncounterZone,1:Integer
SetVATSTarget||r|1:Integer
GetMapMarkerVisible||rk|
ResetInventory||r|
PlayerKnows||k|81:Knowable Form
GetPermanentActorValue|GetPermAV|rk|5:Actor Value
GetKillingBlowLimb||rk|
GoToJail||r|17?:Faction (Optional),1?:Integer (Optional),1?:Integer (Optional)
CanPayCrimeGold||rk|17?:Faction (Optional)
ServeTime|||
GetDaysInJail||rk|
EPAlchemyGetMakingPoison||0k|
EPAlchemyEffectHasKeyword||0k|59:Keyword
ShowAllMapMarkers|tmm||1:Integer,1?:Integer (Optional),1?:Integer (Optional)
GetAllowWorldInteractions||rk|
ResetAI||r|
SetRumble|||2:Float,2:Float,2:Float
SetNoActivationSound|||12:Sound
ClearNoActivationSound|||
GetLastHitCritical||rk|
AddMusic|||57:Music
UnusedFunction3||x|
UnusedFunction4||rx|
SetPCToddler|||1:Integer
IsCombatTarget||rk|6:Actor
TriggerScreenBlood|tsb||1:Integer
GetVATSRightAreaFree||rk|4?:TESObjectREFR
GetVATSLeftAreaFree||rk|4?:TESObjectREFR
GetVATSBackAreaFree||rk|4?:TESObjectREFR
GetVATSFrontAreaFree||rk|4?:TESObjectREFR
GetIsLockBroken||rk|
IsPS3||k|
IsWin32||k|
GetVATSRightTargetVisible||rk|4:TESObjectREFR
GetVATSLeftTargetVisible||rk|4:TESObjectREFR
GetVATSBackTargetVisible||rk|4:TESObjectREFR
GetVATSFrontTargetVisible||rk|4:TESObjectREFR
AttachAshPile||r|1?:Integer (Optional)
SetCriticalStage||r|58:CriticalStage
IsInCriticalStage||rk|58:CriticalStage
RemoveFromAllFactions||r|
GetXPForNextLevel||k|
ShowLockpickMenuDebug|slpmd||1?:Integer (Optional)
ForceSave|||
GetInfamy||k|17?:Faction (Optional)
GetInfamyViolent||k|17?:Faction (Optional)
GetInfamyNonViolent||k|17?:Faction (Optional)
UnusedFunction5||rx|
Sin|||2:Float,1?:Int(optional)
Cos|||2:Float,1?:Int(optional)
Tan|||2:Float,1?:Int(optional)
Sqrt|||2:Float
Log|||2:Float,2?:Float(optional)
Abs|||2:Float
GetQuestCompleted|GetQC|k|14:Quest
UnusedFunction6||rx|
PipBoyRadioOff||0|
AutoDisplayObjectives||0|1:Integer
IsGoreDisabled||k|
FadeSFX|FSFX||2:Float
SetMinimalUse||r|1:Integer
IsSceneActionComplete||k|67:Scene,1:Integer
ShowQuestStages|SQS||14:Quest
GetSpellUsageNum||rk|11:Magic Item
ForceRadioStationUpdate|FRSU|0|
GetActorsInHigh||k|
HasLoaded3D||k|
DisableAllMines||0|
SetLastExtDoorActivated|||4:ObjectReferenceID
KillQuestUpdates|KQU|0|
IsImageSpaceActive|||42:Imagespace Modifier ID
HasKeyword||rk|59:Keyword
HasRefType||rk|60:RefType
LocationHasKeyword||rk|59:Keyword
LocationHasRefType||rk|60:RefType
CreateEvent|||59:Keyword,61?:Location,4?:Ref 1,4?:Ref 2,1?:Value 1,1?:Value 2
GetIsEditorLocation||rk|61:Location
GetIsAliasRef||rk|63:QuestAlias
GetIsEditorLocAlias||rk|63:QuestAlias
IsSprinting||rk|
IsBlocking||rk|
HasEquippedSpell|hasspell|rk|68:Casting Source
GetCurrentCastingType|getcasting|rk|68:Casting Source
GetCurrentDeliveryType|getdelivery|rk|68:Casting Source
EquipSpell||r|7:Spell Item,68:Casting Source
GetAttackState||rk|
GetAliasedRef|||63:QuestAlias
GetEventData||k|46:Event Function,47:Event Member,48?:Data (Optional)
IsCloserToAThanB||rk|4:TESObjectREFR,4:TESObjectREFR
EquipShout||r|64:Shout
GetEquippedShout||rk|64:Shout
IsBleedingOut||rk|
UnlockWord|||65:Word Of Power
TeachWord|||65:Word Of Power
AddToContainer||r|4:TESObjectREFR,1?:Flag
GetRelativeAngle||rk|4:ObjectReferenceID,8:Axis
SendAnimEvent|sae|r|0:String
Shout||r|64:Shout,1:Integer,4:ObjectReferenceID
AddShout||r|64:Shout
RemoveShout||r|64:Shout
GetMovementDirection||rk|
IsInScene||rk|
GetRefTypeDeadCount||k|61:Location,60:RefType
GetRefTypeAliveCount||k|61:Location,60:RefType
ApplyHavokImpulse||r|2:Float,2:Float,2:Float,2:Float
GetIsFlying||rk|
IsCurrentSpell||rk|7:Spell Item,68:Casting Source
SpellHasKeyword||rk|68:Casting Source,59:Keyword
GetEquippedItemType||rk|68:Casting Source
GetLocationAliasCleared||k|63:QuestAlias
SetLocationAliasCleared|||63:QuestAlias
GetLocAliasRefTypeDeadCount||k|63:QuestAlias,60:RefType
GetLocAliasRefTypeAliveCount||k|63:QuestAlias,60:RefType
IsWardState||rk|70:Ward State
IsInSameCurrentLocAsRef||rk|4:TESObjectREFR,59?:Keyword
IsInSameCurrentLocAsRefAlias||rk|63:QuestAlias,59?:Keyword
LocAliasIsLocation||k|63:QuestAlias,61:Location
GetKeywordDataForLocation||k|61:Location,59:Keyword
SetKeywordDataForLocation|||61:Location,59:Keyword,2:Value
GetKeywordDataForAlias||k|63:QuestAlias,59:Keyword
SetKeywordDataForAlias|||63:QuestAlias,59:Keyword,2:Value
LocAliasHasKeyword||k|63:QuestAlias,59:Keyword
IsNullPackageData||rk|71:PackageData (Possibly Null)
GetNumericPackageData||rk|72:PackageData (Numeric)
IsFurnitureAnimType||rk|73:Furniture Anim Type
IsFurnitureEntryType||rk|74:Furniture Entry Type
GetHighestRelationshipRank||rk|
GetLowestRelationshipRank||rk|
HasAssociationTypeAny||rk|69:AssociationType
HasFamilyRelationshipAny||rk|
GetPathingTargetOffset||rk|8:Axis
GetPathingTargetAngleOffset||rk|8:Axis
GetPathingTargetSpeed||rk|
GetPathingTargetSpeedAngle||rk|8:Axis
GetMovementSpeed||rk|
GetInContainer||rk|4:TESObjectREFR
IsLocationLoaded||k|61:Location
IsLocAliasLoaded||k|63:QuestAlias
IsDualCasting||rk|
DualCast||r|11:Magic Item,4:ObjectReferenceID (Optional)
GetVMQuestVariable||xk|14:Quest,76:VM Variable Name
GetVMScriptVariable||xk|4:ObjectReferenceID,76:VM Variable Name
IsEnteringInteractionQuick||rk|
IsCasting||rk|
GetFlyingState||rk|
SetFavorState||r|1:Integer
IsInFavorState||rk|
HasTwoHandedWeaponEquipped||rk|
IsExitingInstant||rk|
IsInFriendStatewithPlayer||rk|
GetWithinDistance||rk|4:ObjectReferenceID,2:Float
GetActorValuePercent||rk|5:Actor Value
IsUnique||rk|
GetLastBumpDirection||rk|
CameraShake|||2:Float,2?:Float(optional)
IsInFurnitureState||rk|73:Furniture Anim Type
GetIsInjured||rk|
GetIsCrashLandRequest||rk|
GetIsHastyLandRequest||rk|
UpdateQuestInstanceGlobal|||14:Quest,19:Global
SetAllowFlying||r|1:Integer
IsLinkedTo||rk|4:TESObjectREFR,59?:Keyword
GetKeywordDataForCurrentLocation||rk|59:Keyword
GetInSharedCrimeFaction||rk|4:TESObjectREFR
GetBribeAmount||r|
GetBribeSuccess||rk|
GetIntimidateSuccess||rk|
GetArrestedState||rk|
GetArrestingActor||rk|
ClearArrestState||r|
EPTemperingItemIsEnchanted||0k|
EPTemperingItemHasKeyword||0k|59:Keyword
GetReceivedGiftValue||r|
GetGiftGivenValue||r|
ForceLocIntoAlias|||61:Location,63:QuestAlias
GetReplacedItemType||rk|68:Casting Source
SetHorseActor||r|4:TESObjectREFR
PlayReferenceEffect|pre|r|77:Reference Effect,2?:Time (optional),4?:Aim-at target (optional)
StopReferenceEffect|sre|r|77:Reference Effect
PlayShaderParticleGeometry|pspg||62:Form,2:Float
StopShaderParticleGeometry|sspg||62:Form,2:Float
ApplyImageSpaceModifierCrossFade|imodcf||42:Imagespace Modifier ID,2?:Float (Optional)
RemoveImageSpaceModifierCrossFade|rimodcf||2?:Float (Optional)
IsAttacking||rk|
IsPowerAttacking||rk|
IsLastHostileActor||rk|
GetGraphVariableInt||rk|0:String
GetCurrentShoutVariation||rk|
PlayImpactEffect|pie|r|0:String,0?:String (Optional),2?:Float(optional),2?:Float(optional),2?:Float(optional),2?:Float(optional),1?:Int(optional),1?:Int(optional)
ShouldAttackKill||rk|6:Actor
SendStealAlarm|steal|r|6:Actor
GetActivationHeight||rk|
EPModSkillUsage_IsAdvanceSkill||0k|5:Actor Value
WornHasKeyword||rk|59:Keyword
GetPathingCurrentSpeed||rk|
GetPathingCurrentSpeedAngle||rk|8:Axis
KnockAreaEffect|kae|r|2:Float,2:Float
InterruptCast||r|
AddFormToFormList|||62:Form,62:Form
RevertFormList|||62:Form
AddFormToLeveledList|||62:Form,62:Form,1:Int,1:Int
RevertLeveledList|||62:Form
EPModSkillUsage_AdvanceObjectHasKeyword||0k|59:Keyword
EPModSkillUsage_IsAdvanceAction||0k|80:Skill Action
EPMagic_SpellHasKeyword||0k|59:Keyword
GetNoBleedoutRecovery||rk|
SetNoBleedoutRecovery||r|1:Integer
EPMagic_SpellHasSkill||0k|5:Actor Value
IsAttackType||0k|59:Keyword
IsAllowedToFly||rk|
HasMagicEffectKeyword||rk|59:Keyword
IsCommandedActor||rk|
IsStaggered||rk|
IsRecoiling||rk|
IsExitingInteractionQuick||rk|
IsPathing||rk|
GetShouldHelp||rk|6:Actor
HasBoundWeaponEquipped||rk|68:Casting Source
GetCombatTargetHasKeyword|gcthk|rk|59:Keyword
UpdateLevel|||
GetCombatGroupMemberCount|gcgmc|rk|
IsIgnoringCombat||rk|
GetLightLevel|gll|rk|
SavePCFace|spf||0:String
SpellHasCastingPerk||0k|39:Perk
IsBeingRidden||rk|
IsUndead||r0k|
GetRealHoursPassed||k|
UnequipAll|||
IsUnlockedDoor||rk|
IsHostileToActor||rk|6:Actor
GetTargetHeight||rk|4:TESObjectREFR
IsPoison||r0k|
WornApparelHasKeywordCount||rk|59:Keyword
GetItemHealthPercent||rk|
EffectWasDualCast||rk|
GetKnockStateEnum||rk|
DoesNotExist||k|
UnequipItemSlot||r|1:Integer
MountActor||r|4:TESObjectREFR
DismountActor||r|
IsOnFlyingMount||rk|
CanFlyHere||rk|
IsFlyingMountPatrolQueued||k|
IsFlyingMountFastTravelling||k|
IsOverEncumbered||rk|
GetActorWarmth||rk|
KillAllHostile|kah||6?:Actor (optional)
`;
