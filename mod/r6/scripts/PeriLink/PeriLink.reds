// PeriLink — lets the Operator (Peri) cast the host's REAL quickhacks.
//
// Uses the same code path as the game's own quickhack menu, so his cyberdeck,
// RAM, crafted tiers, perks, upload times, ICE and cooldowns all apply.
// Also (optionally) blocks the host from uploading quickhacks himself.
//
// Installed by NeuralLink into <game>/r6/scripts/PeriLink/PeriLink.reds
// Requires redscript. Called from the CoopOperator CET mod.

// ---------------------------------------------------------------------------
// Settings that live for the game session
// ---------------------------------------------------------------------------

public class PeriLinkSystem extends ScriptableSystem {
  // false (the default) = only Peri can hack. The host app can turn it on.
  private let m_hostCanHack: Bool;

  public func SetHostCanHack(allowed: Bool) -> Void {
    this.m_hostCanHack = allowed;
  }

  public func HostCanHack() -> Bool {
    return this.m_hostCanHack;
  }

  public static func Get(game: GameInstance) -> ref<PeriLinkSystem> {
    return GameInstance.GetScriptableSystemsContainer(game).Get(n"PeriLinkSystem") as PeriLinkSystem;
  }
}

// ---------------------------------------------------------------------------
// Helpers called from CET
// ---------------------------------------------------------------------------

public class PeriLinkApi {

  // His equipped quickhacks that work on people, in deck order
  // Each quickhack program has several internal variants with the same name,
  // so group them: one entry per program, keeping the highest tier.
  public static func GetDeck(player: ref<PlayerPuppet>) -> array<PlayerQuickhackData> {
    return PeriLinkApi.GroupDeck(RPGManager.GetPlayerQuickHackListWithQuality(player));
  }

  public static func GroupDeck(all: array<PlayerQuickhackData>) -> array<PlayerQuickhackData> {
    let deck: array<PlayerQuickhackData>;
    for q in all {
      if IsDefined(q.actionRecord)
         && Equals(q.actionRecord.ObjectActionType().Type(), gamedataObjectActionType.PuppetQuickHack) {
        let name = PeriLinkApi.HackName(q.actionRecord);
        let found = -1;
        let j = 0;
        while j < ArraySize(deck) {
          if found < 0 && Equals(PeriLinkApi.HackName(deck[j].actionRecord), name) {
            found = j;
          }
          j += 1;
        }
        if found < 0 {
          ArrayPush(deck, q);
        } else {
          if q.quality > deck[found].quality {
            deck[found] = q;
          }
        }
      }
    }
    return deck;
  }

  // ---------- Experimental: Peri's own cyberdeck ----------

  // True when experimental mode is on AND he has no cyberdeck equipped
  public static func UsingVirtual(player: ref<PlayerPuppet>, enabled: Bool) -> Bool {
    return enabled && !EquipmentSystem.IsCyberdeckEquipped(player);
  }

  // Quickhack programs in Peri's virtual deck. Names not found in this game version are skipped.
  public static func VirtualPrograms() -> array<TweakDBID> {
    let ids: array<TweakDBID>;
    ArrayPush(ids, t"Items.PingProgram");
    ArrayPush(ids, t"Items.BlindProgram");
    ArrayPush(ids, t"Items.OverheatProgram");
    ArrayPush(ids, t"Items.EMPOverloadProgram");
    ArrayPush(ids, t"Items.WhistleProgram");
    ArrayPush(ids, t"Items.LocomotionMalfunctionProgram");
    ArrayPush(ids, t"Items.WeaponMalfunctionProgram");
    ArrayPush(ids, t"Items.ContagionProgram");
    ArrayPush(ids, t"Items.MemoryWipeLvl2Program");
    ArrayPush(ids, t"Items.BrainMeltLvl2Program");
    return ids;
  }

  // Every NPC quickhack action in the virtual deck (not grouped)
  public static func GetVirtualDeckAll() -> array<PlayerQuickhackData> {
    let list: array<PlayerQuickhackData>;
    for id in PeriLinkApi.VirtualPrograms() {
      let rec = TweakDBInterface.GetItemRecord(id);
      if IsDefined(rec) {
        let acts: array<wref<ObjectAction_Record>>;
        rec.ObjectActions(acts);
        for a in acts {
          if IsDefined(a) && Equals(a.ObjectActionType().Type(), gamedataObjectActionType.PuppetQuickHack) {
            let q: PlayerQuickhackData;
            q.itemID = ItemID.FromTDBID(id);
            q.actionRecord = a;
            q.quality = 1;
            if IsDefined(rec.Quality()) { q.quality = rec.Quality().Value(); }
            ArrayPush(list, q);
          }
        }
      }
    }
    return list;
  }

  // Deck shown to Peri: his real one, or the virtual one when that applies
  public static func GetDeckFor(player: ref<PlayerPuppet>, virtualEnabled: Bool) -> array<PlayerQuickhackData> {
    if PeriLinkApi.UsingVirtual(player, virtualEnabled) {
      return PeriLinkApi.GroupDeck(PeriLinkApi.GetVirtualDeckAll());
    }
    return PeriLinkApi.GetDeck(player);
  }

  // Every quickhack action Peri can use right now (not grouped): his deck, or the virtual one
  public static func GetDeckAllFor(player: ref<PlayerPuppet>, virtualEnabled: Bool) -> array<PlayerQuickhackData> {
    if PeriLinkApi.UsingVirtual(player, virtualEnabled) {
      return PeriLinkApi.GetVirtualDeckAll();
    }
    return RPGManager.GetPlayerQuickHackListWithQuality(player);
  }

  // Ultimate side effect: take `percent` of max health, but never go below `floor` percent.
  // Never fatal. Returns the health % after.
  public static func Hurt(player: ref<PlayerPuppet>, percent: Float, floor: Float) -> Float {
    let pools = GameInstance.GetStatPoolsSystem(player.GetGame());
    let id = Cast<StatsObjectID>(player.GetEntityID());
    let current = pools.GetStatPoolValue(id, gamedataStatPoolType.Health, true);
    let target = MaxF(current - percent, MinF(current, floor));
    if target < current {
      pools.RequestSettingStatPoolValue(id, gamedataStatPoolType.Health, target, player, true);
    }
    return target;
  }

  public static func GetLevel(player: ref<PlayerPuppet>) -> Float {
    return GameInstance.GetStatsSystem(player.GetGame()).GetStatValue(Cast<StatsObjectID>(player.GetEntityID()), gamedataStatType.Level);
  }

  public static func HackName(record: wref<ObjectAction_Record>) -> String {
    return GetLocalizedTextByKey(record.ObjectActionUI().Caption());
  }

  // One line per hack: "name|base RAM cost|tier|ultimate(0/1)"
  public static func DescribeDeck(player: ref<PlayerPuppet>, virtualEnabled: Bool) -> array<String> {
    let lines: array<String>;
    for q in PeriLinkApi.GetDeckFor(player, virtualEnabled) {
      let ultimate = IsDefined(q.actionRecord.HackCategory())
        && Equals(q.actionRecord.HackCategory().Type(), gamedataHackCategory.UltimateHack);
      ArrayPush(lines,
        PeriLinkApi.HackName(q.actionRecord) + "|"
        + IntToString(BaseScriptableAction.GetBaseCostStatic(player, q.actionRecord)) + "|"
        + IntToString(q.quality) + "|"
        + (ultimate ? "1" : "0"));
    }
    return lines;
  }

  // [current RAM, max RAM]
  public static func GetRam(player: ref<PlayerPuppet>) -> array<Float> {
    let game = player.GetGame();
    let ram: array<Float>;
    ArrayPush(ram, GameInstance.GetStatPoolsSystem(game).GetStatPoolValue(Cast<StatsObjectID>(player.GetEntityID()), gamedataStatPoolType.Memory, false));
    ArrayPush(ram, GameInstance.GetStatsSystem(game).GetStatValue(Cast<StatsObjectID>(player.GetEntityID()), gamedataStatType.Memory));
    return ram;
  }

  public static func SetHostCanHack(player: ref<PlayerPuppet>, allowed: Bool) -> Void {
    let system = PeriLinkSystem.Get(player.GetGame());
    if IsDefined(system) {
      system.SetHostCanHack(allowed);
    }
  }

  // Slow motion, the way the Sandevistan does it (TimeSystem with a named reason).
  // mode 1 = "burst": world slows, V keeps full speed.
  // mode 2 = "focus": everything slows (V too), so Peri can aim hacks calmly.
  public static func Slow(player: ref<PlayerPuppet>, mode: Int32, on: Bool, dilation: Float) -> Bool {
    let ts = GameInstance.GetTimeSystem(player.GetGame());
    if !IsDefined(ts) {
      return false;
    }
    let reason = n"PeriLinkFocus";
    if mode == 1 { reason = n"PeriLinkBurst"; }
    if mode == 3 { reason = n"PeriLinkUltimate"; }
    if on {
      ts.SetIgnoreTimeDilationOnLocalPlayerZero(mode == 1);
      // Same as the Sandevistan: a long duration (999 s), switched off by us on release
      ts.SetTimeDilation(reason, dilation, 999.0);
    } else {
      ts.UnsetTimeDilation(reason, n"");
      ts.SetIgnoreTimeDilationOnLocalPlayerZero(false);
    }
    return true;
  }

  // Quickhack list -> lines "title|RAM cost|locked(0/1)|reason"
  public static func DescribeCommands(all: array<ref<QuickhackData>>) -> array<String> {
    let commands = PeriLinkApi.Unique(all);
    let lines: array<String>;
    for cmd in commands {
      if cmd.m_noQuickhackData {
        ArrayPush(lines, "No quickhacks|0|1|He has no cyberdeck quickhacks");
      } else {
        let locked = cmd.m_isLocked || !IsDefined(cmd.m_action);
        let reason = locked ? GetLocalizedText(cmd.m_inactiveReason) : "";
        ArrayPush(lines,
          PeriLinkApi.Clean(PeriLinkApi.CommandTitle(cmd)) + "|"
          + IntToString(cmd.m_cost) + "|"
          + (locked ? "1" : "0") + "|"
          + PeriLinkApi.Clean(reason));
      }
    }
    return lines;
  }

  // Same-named variants collapsed into one: keep the first usable one, else the first
  public static func Unique(all: array<ref<QuickhackData>>) -> array<ref<QuickhackData>> {
    let out: array<ref<QuickhackData>>;
    for cmd in all {
      let title = PeriLinkApi.CommandTitle(cmd);
      let found = -1;
      let j = 0;
      while j < ArraySize(out) {
        if found < 0 && Equals(PeriLinkApi.CommandTitle(out[j]), title) {
          found = j;
        }
        j += 1;
      }
      if found < 0 {
        ArrayPush(out, cmd);
      } else {
        if PeriLinkApi.IsUsable(cmd) && !PeriLinkApi.IsUsable(out[found]) {
          out[found] = cmd;
        }
      }
    }
    return out;
  }

  public static func IsUsable(cmd: ref<QuickhackData>) -> Bool {
    return !cmd.m_isLocked && IsDefined(cmd.m_action);
  }

  public static func CommandTitle(cmd: ref<QuickhackData>) -> String {
    let title = GetLocalizedText(cmd.m_title);
    if StrLen(title) == 0 { title = GetLocalizedText(cmd.m_titleAlternative); }
    return title;
  }

  // Run one entry of a quickhack list. Prefers the entry with the same title (the
  // list may have changed since Peri saw it), else the one at that index.
  // ram < 0: use his real RAM (normal). ram >= 0: Peri's virtual RAM budget.
  // Returns "ok|<hack>|<cost>" or "fail|<reason>".
  public static func Pick(player: ref<PlayerPuppet>, target: ref<GameObject>, commands: array<ref<QuickhackData>>, index: Int32, title: String, ram: Int32) -> String {
    let chosen: ref<QuickhackData>;
    if StrLen(title) > 0 {
      for cmd in commands {
        if Equals(PeriLinkApi.Clean(PeriLinkApi.CommandTitle(cmd)), title) {
          if !IsDefined(chosen) || (PeriLinkApi.IsUsable(cmd) && !PeriLinkApi.IsUsable(chosen)) {
            chosen = cmd;
          }
        }
      }
    }
    if !IsDefined(chosen) && index >= 0 && index < ArraySize(commands) {
      chosen = commands[index];
    }
    if !IsDefined(chosen) {
      return "fail|" + title + " isn't available anymore";
    }
    let name = PeriLinkApi.CommandTitle(chosen);
    if chosen.m_isLocked || !IsDefined(chosen.m_action) {
      let reason = GetLocalizedText(chosen.m_inactiveReason);
      if StrLen(reason) == 0 { reason = "can't upload right now"; }
      return "fail|" + name + ": " + reason;
    }
    if ram >= 0 && chosen.m_cost > ram {
      return "fail|" + name + ": not enough RAM (" + IntToString(chosen.m_cost) + " needed)";
    }
    let evt = new QuickSlotCommandUsed();
    evt.action = chosen.m_action;
    player.QueueEventForEntityID(target.GetEntityID(), evt);
    return "ok|" + PeriLinkApi.Clean(name) + "|" + IntToString(chosen.m_cost);
  }

  // "|" separates fields for the CET side, so keep it out of names
  public static func Clean(text: String) -> String {
    return StrReplaceAll(text, "|", "/");
  }

  // Small message in the middle of the HUD
  public static func ShowMessage(game: GameInstance, text: String) -> Void {
    let msg: SimpleScreenMessage;
    msg.isShown = true;
    msg.duration = 2.5;
    msg.message = text;
    msg.isInstant = true;
    let bb = GameInstance.GetBlackboardSystem(game).Get(GetAllBlackboardDefs().UI_Notifications);
    bb.SetVariant(GetAllBlackboardDefs().UI_Notifications.OnscreenMessage, ToVariant(msg), true);
  }
}

// ---------------------------------------------------------------------------
// NPCs
// ---------------------------------------------------------------------------

// This NPC's quickhack list, built exactly like the scanner menu does
@addMethod(ScriptedPuppet)
public func PeriLinkBuildCommands() -> array<ref<QuickhackData>> {
  let player = GetPlayer(this.GetGame());
  let context = this.GetPS().GenerateContext(gamedeviceRequestType.Remote, Device.GetInteractionClearance(), player, this.GetEntityID());
  let records: array<wref<ObjectAction_Record>>;
  this.GetRecord().ObjectActions(records);
  let actions: array<ref<PuppetAction>>;
  this.GetPS().GetAllChoices(records, context, actions);
  let commands: array<ref<QuickhackData>>;
  this.TranslateChoicesIntoQuickSlotCommands(actions, commands);
  return commands;
}

@addMethod(ScriptedPuppet)
public func PeriLinkName() -> String {
  return PeriLinkApi.Clean(GetLocalizedText(this.GetDisplayName()));
}

// For the OVERRIDE radar: "<threat>|<upload 0..1>|<hack>,<hack>"
//   threat: red (hostile, or aggressive and not friendly — the game's own red nameplate rule),
//           yellow (neutral and could fight), civ (civilians / crowd / friendly), dead
//   upload: how far a quickhack upload on this NPC has got (0 = none)
//   hacks:  quickhack effects currently on it, by their in-game names
@addMethod(ScriptedPuppet)
public func PeriLinkThreat() -> String {
  if this.IsDead() || ScriptedPuppet.IsDefeated(this) || ScriptedPuppet.IsUnconscious(this) {
    return "dead|0|";
  }
  let player = GetPlayer(this.GetGame());
  let threat = "civ";
  if IsDefined(player) {
    let attitude = GameObject.GetAttitudeTowards(this, player);
    let npc = this as NPCPuppet;
    let aggressive = IsDefined(npc) && npc.IsAggressive() && NotEquals(attitude, EAIAttitude.AIA_Friendly);
    if Equals(attitude, EAIAttitude.AIA_Hostile) || aggressive {
      threat = "red";
    } else {
      if Equals(attitude, EAIAttitude.AIA_Neutral) && !this.IsCharacterCivilian() && !this.IsCrowd() {
        threat = "yellow";
      }
    }
  }

  let names = "";
  let hacks: array<ref<StatusEffect>>;
  StatusEffectHelper.GetAppliedEffectsWithTag(this, n"Quickhack", hacks);
  for hack in hacks {
    let record = hack.GetRecord();
    let name = "";
    if IsDefined(record) && IsDefined(record.UiData()) {
      name = GetLocalizedText(record.UiData().DisplayName());
    }
    name = StrReplaceAll(StrReplaceAll(PeriLinkApi.Clean(name), ",", " "), "\"", "");
    if StrLen(name) > 0 && !StrContains(names, name) {
      if StrLen(names) > 0 { names += ","; }
      names += name;
    }
  }

  let upload = 0.0;
  let pools = GameInstance.GetStatPoolsSystem(this.GetGame());
  let statsId = Cast<StatsObjectID>(this.GetEntityID());
  if pools.IsStatPoolAdded(statsId, gamedataStatPoolType.QuickHackUpload) {
    upload = pools.GetStatPoolValue(statsId, gamedataStatPoolType.QuickHackUpload, true) / 100.0;
  }
  return threat + "|" + FloatToStringPrec(upload, 2) + "|" + names;
}

// Experimental: the same list, built from Peri's virtual deck (no cyberdeck needed).
// Mirrors the game's own checks; RAM is paid from Peri's pool, not his.
@addMethod(ScriptedPuppet)
public func PeriLinkBuildVirtualCommands() -> array<ref<QuickhackData>> {
  return this.PeriLinkBuildFreeCommands(PeriLinkApi.GetVirtualDeckAll());
}

// Builds this NPC's list from any deck, ignoring RAM (Peri pays, or the ultimate makes it free)
@addMethod(ScriptedPuppet)
public func PeriLinkBuildFreeCommands(deckAll: array<PlayerQuickhackData>) -> array<ref<QuickhackData>> {
  let player = GetPlayer(this.GetGame());
  let context = this.GetPS().GenerateContext(gamedeviceRequestType.Remote, Device.GetInteractionClearance(), player, this.GetEntityID());
  let records: array<wref<ObjectAction_Record>>;
  this.GetRecord().ObjectActions(records);
  let actions: array<ref<PuppetAction>>;
  this.GetPS().GetAllChoices(records, context, actions);

  let preventHacking = GameInstance.GetStatsSystem(this.GetGame()).GetStatValue(Cast<StatsObjectID>(this.GetEntityID()), gamedataStatType.PreventQuickhacking) > 0.0;
  let uploading = this.HasActiveQuickHackUpload();
  let commands: array<ref<QuickhackData>>;

  for q in deckAll {
    for action in actions {
      if Equals(q.actionRecord.ActionName(), action.GetObjectActionRecord().ActionName()) {
        if q.actionRecord.Priority() >= action.GetObjectActionRecord().Priority() {
          action.SetObjectActionID(q.actionRecord.GetID());
        }
        let cmd = new QuickhackData();
        cmd.m_title = LocKeyToString(q.actionRecord.ObjectActionUI().Caption());
        cmd.m_itemID = q.itemID;
        cmd.m_actionOwner = this.GetEntityID();
        cmd.m_quality = q.quality;
        cmd.m_cost = action.GetCost();
        if preventHacking {
          cmd.m_isLocked = true;
          cmd.m_inactiveReason = "LocKey#27694";
        } else {
          if !action.IsPossible(this) || !action.IsVisible(player) {
            cmd.m_isLocked = true;
            cmd.m_inactiveReason = "LocKey#7019";
          } else {
            if action.IsInactive() {
              cmd.m_isLocked = true;
              cmd.m_inactiveReason = action.GetInactiveReason();
            } else {
              if uploading {
                cmd.m_isLocked = true;
                cmd.m_inactiveReason = "LocKey#7020";
              } else {
                action.SetCanSkipPayCost(true);   // Peri's RAM, not his
                cmd.m_action = action;
              }
            }
          }
        }
        ArrayPush(commands, cmd);
      }
    }
  }
  return commands;
}

// free = ultimate active: no RAM needed, any deck
@addMethod(ScriptedPuppet)
public func PeriLinkCommandsFor(virtualMode: Bool, free: Bool, virtualEnabled: Bool) -> array<ref<QuickhackData>> {
  if free {
    return this.PeriLinkBuildFreeCommands(PeriLinkApi.GetDeckAllFor(GetPlayer(this.GetGame()), virtualEnabled));
  }
  if virtualMode {
    return this.PeriLinkBuildVirtualCommands();
  }
  return this.PeriLinkBuildCommands();
}

// virtualEnabled: experimental mode switched on. ram: Peri's virtual RAM (used only in virtual mode).
@addMethod(ScriptedPuppet)
public func PeriLinkMenu(virtualEnabled: Bool, free: Bool) -> array<String> {
  let virtualMode = PeriLinkApi.UsingVirtual(GetPlayer(this.GetGame()), virtualEnabled);
  return PeriLinkApi.DescribeCommands(this.PeriLinkCommandsFor(virtualMode, free, virtualEnabled));
}

@addMethod(ScriptedPuppet)
public func PeriLinkPick(index: Int32, title: String, virtualEnabled: Bool, ram: Int32, free: Bool) -> String {
  if this.IsDead() || ScriptedPuppet.IsDefeated(this) {
    return "fail|Target is down";
  }
  let player = GetPlayer(this.GetGame());
  let virtualMode = PeriLinkApi.UsingVirtual(player, virtualEnabled);
  let budget = -1;
  if virtualMode && !free { budget = ram; }
  return PeriLinkApi.Pick(player, this, this.PeriLinkCommandsFor(virtualMode, free, virtualEnabled), index, title, budget);
}

// Real cost of each hotbar slot against this NPC, for Peri's hotbar.
// One line per deck slot: "<cost>|<usable 0/1>", or "-1|0" if that hack doesn't apply here.
@addMethod(ScriptedPuppet)
public func PeriLinkSlotCosts(virtualEnabled: Bool, free: Bool) -> array<String> {
  let player = GetPlayer(this.GetGame());
  let lines: array<String>;
  if !IsDefined(player) { return lines; }
  let virtualMode = PeriLinkApi.UsingVirtual(player, virtualEnabled);
  let deck = PeriLinkApi.GetDeckFor(player, virtualEnabled);
  let commands = this.PeriLinkCommandsFor(virtualMode, free, virtualEnabled);
  for q in deck {
    let cost = -1;
    let usable = false;
    for cmd in commands {
      if Equals(cmd.m_itemID, q.itemID) {
        if cost < 0 || (PeriLinkApi.IsUsable(cmd) && !usable) {
          cost = cmd.m_cost;
          usable = PeriLinkApi.IsUsable(cmd);
        }
      }
    }
    ArrayPush(lines, IntToString(cost) + "|" + (usable ? "1" : "0"));
  }
  return lines;
}

// Peri casts slot N of his deck on this NPC. Returns "ok|<hack>" or "fail|<reason>".
@addMethod(ScriptedPuppet)
public func PeriLinkCast(slot: Int32, virtualEnabled: Bool, ram: Int32, free: Bool) -> String {
  let player = GetPlayer(this.GetGame());
  if !IsDefined(player) {
    return "fail|No player";
  }
  let virtualMode = PeriLinkApi.UsingVirtual(player, virtualEnabled);
  let budget = -1;
  if virtualMode && !free { budget = ram; }
  let deck = PeriLinkApi.GetDeckFor(player, virtualEnabled);
  if slot < 0 || slot >= ArraySize(deck) {
    return "fail|Empty slot";
  }
  let wanted = deck[slot].itemID;
  let title = PeriLinkApi.HackName(deck[slot].actionRecord);

  if this.IsDead() || ScriptedPuppet.IsDefeated(this) {
    return "fail|" + title + ": target is down";
  }

  // The program's variants all share its item; use one that works on this target
  let commands = this.PeriLinkCommandsFor(virtualMode, free, virtualEnabled);
  let fallback = -1;
  let i = 0;
  while i < ArraySize(commands) {
    if Equals(commands[i].m_itemID, wanted) {
      if PeriLinkApi.IsUsable(commands[i]) {
        return PeriLinkApi.Pick(player, this, commands, i, "", budget);
      }
      if fallback < 0 { fallback = i; }
    }
    i += 1;
  }
  if fallback >= 0 {
    return PeriLinkApi.Pick(player, this, commands, fallback, "", budget);   // reports why it's locked
  }
  return "fail|" + title + " doesn't work on this target";
}

// ---------------------------------------------------------------------------
// Devices: cameras, turrets, doors, vending machines, speakers...
// ---------------------------------------------------------------------------

// This device's quickhack list, built exactly like the scanner menu does
@addMethod(Device)
public func PeriLinkBuildCommands() -> array<ref<QuickhackData>> {
  let player = GetPlayer(this.GetGame());
  let context = this.GetDevicePS().GenerateContext(gamedeviceRequestType.Remote, Device.GetInteractionClearance(), player, this.GetEntityID());
  let actions: array<ref<DeviceAction>>;
  this.GetDevicePS().GetRemoteActions(actions, context);
  if (this.m_isQhackUploadInProgerss && !this.IsActionQueueEnabled()) || this.IsActionQueueFull() {
    ScriptableDeviceComponentPS.SetActionsInactiveAll(actions, "LocKey#7020");
  }
  let commands: array<ref<QuickhackData>>;
  QuickHackableHelper.TranslateActionsIntoQuickSlotCommands(actions, commands, this, this.GetDevicePS());
  return commands;
}

@addMethod(Device)
public func PeriLinkName() -> String {
  let name = GetLocalizedText(this.GetDeviceName());
  if StrLen(name) == 0 { name = GetLocalizedText(this.GetDisplayName()); }
  if StrLen(name) == 0 { name = "Device"; }
  return PeriLinkApi.Clean(name);
}

// Experimental: every quickhack this device offers, paid from Peri's RAM
@addMethod(Device)
public func PeriLinkBuildVirtualCommands() -> array<ref<QuickhackData>> {
  let player = GetPlayer(this.GetGame());
  let context = this.GetDevicePS().GenerateContext(gamedeviceRequestType.Remote, Device.GetInteractionClearance(), player, this.GetEntityID());
  let actions: array<ref<DeviceAction>>;
  this.GetDevicePS().GetRemoteActions(actions, context);
  let uploading = (this.m_isQhackUploadInProgerss && !this.IsActionQueueEnabled()) || this.IsActionQueueFull();
  let commands: array<ref<QuickhackData>>;
  for a in actions {
    let sAction = a as ScriptableDeviceAction;
    if IsDefined(sAction) && sAction.IsQuickHack() && IsDefined(sAction.GetObjectActionRecord()) {
      let cmd = new QuickhackData();
      cmd.m_title = LocKeyToString(sAction.GetObjectActionRecord().ObjectActionUI().Caption());
      cmd.m_actionOwner = this.GetEntityID();
      cmd.m_cost = sAction.GetCost();
      if sAction.IsInactive() {
        cmd.m_isLocked = true;
        cmd.m_inactiveReason = sAction.GetInactiveReason();
      } else {
        if uploading {
          cmd.m_isLocked = true;
          cmd.m_inactiveReason = "LocKey#7020";
        } else {
          sAction.SetCanSkipPayCost(true);   // Peri's RAM, not his
          cmd.m_action = sAction;
        }
      }
      ArrayPush(commands, cmd);
    }
  }
  return commands;
}

@addMethod(Device)
public func PeriLinkCommandsFor(virtualMode: Bool, free: Bool) -> array<ref<QuickhackData>> {
  if virtualMode || free {
    return this.PeriLinkBuildVirtualCommands();
  }
  return this.PeriLinkBuildCommands();
}

@addMethod(Device)
public func PeriLinkMenu(virtualEnabled: Bool, free: Bool) -> array<String> {
  let virtualMode = PeriLinkApi.UsingVirtual(GetPlayer(this.GetGame()), virtualEnabled);
  return PeriLinkApi.DescribeCommands(this.PeriLinkCommandsFor(virtualMode, free));
}

@addMethod(Device)
public func PeriLinkPick(index: Int32, title: String, virtualEnabled: Bool, ram: Int32, free: Bool) -> String {
  let player = GetPlayer(this.GetGame());
  let virtualMode = PeriLinkApi.UsingVirtual(player, virtualEnabled);
  let budget = -1;
  if virtualMode && !free { budget = ram; }
  return PeriLinkApi.Pick(player, this, this.PeriLinkCommandsFor(virtualMode, free), index, title, budget);
}

// ---------------------------------------------------------------------------
// Optional: block the host from uploading quickhacks himself
// ---------------------------------------------------------------------------

@wrapMethod(QuickhacksListGameController)
private func ApplyQuickHack(shouldUseUI: Bool) -> Bool {
  let game = this.GetPlayerControlledObject().GetGame();
  let system = PeriLinkSystem.Get(game);
  if IsDefined(system) && !system.HostCanHack() {
    PeriLinkApi.ShowMessage(game, "Only Peri can hack.");
    return false;
  }
  return wrappedMethod(shouldUseUI);
}
