--[[
  CoopOperator — "one V, two brains" co-op for Cyberpunk 2077
  Cyber Engine Tweaks (CET) mod. Runs on the HOST's PC (the one playing).

  The host opens a NeuralLink room. Peri (the Operator) joins, watches his screen and
  sends commands, which the NeuralLink host app writes into inbox.txt in this folder:

    say|<icon>|<name>|<text> -> message in the HUD, under the Operator's icon + name
    hack|<slot> <x> <y>      -> upload the host's REAL quickhack from deck slot <slot>
                                (0-based) to the NPC nearest screen point (x, y)
    ping|<x> <y>             -> marker on the host's screen ("look here")
    focus|<1 or 0>           -> Peri holds/releases focus (everything slows, drains a meter)
    menu|<x> <y>             -> open the game's hack menu for the NPC/device at (x, y)
    pick|<seq> <i> <title>   -> upload entry <i> of open menu <seq>
    menuclose|               -> close the open menu
    lock|<0 or 1>            -> 1 = the host may hack too, 0 = only Peri (default)
    virtual|<0 or 1>         -> EXPERIMENTAL: Peri's own cyberdeck when he has none
    aim|<x> <y> (or aim|)    -> Peri's mouse position: report real hotbar costs for that target
    ult|                     -> ULTIMATE: radar of everything around V, no RAM, slow time (6 s)
    ulthack|<id> <slot>      -> during the ultimate: upload deck slot to radar target <id>
    ultmenu|<id>             -> during the ultimate: open radar target <id>'s hack menu
                                (ulthack/ultmenu also work on focus name tags)
    aimid|<id>               -> Peri hovers a name tag / radar dot: report real hotbar costs for it

  The mod writes state.json (his deck, RAM, last hack result) for the app to show Peri.

  Real quickhacks go through PeriLink.reds (redscript), which uses the game's own
  quickhack code: his cyberdeck, RAM, tiers, perks and cooldowns all apply.

  VERIFY in-game (the API calls most likely to need adjusting):
    - SetIgnoreTimeDilationOnLocalPlayerZero (V keeps full speed in slow-mo)
    - TSQ_NPC + GetTargetParts (list of NPCs on screen)
    - CameraSystem:ProjectPoint and the flipY setting (world -> screen)
    - ImDrawList functions (drawing the Operator's icon)
]]

local Coop = {
    -- Who is calling. Updated by every message the Operator sends.
    callerName     = "PeriBot",
    callerIcon     = "peri2",
    iconSize       = 0.045,    -- header icon height as a fraction of screen height
    smallIconSize  = 0.024,    -- icon next to each message

    -- Focus (Peri holds Space): everything nearly freezes so Peri can aim hacks
    focusDilation  = 0.1,    -- world speed while focusing (1.0 = normal). Lower = slower
    focusMax       = 6.0,    -- seconds of focus when the meter is full
    focusRecharge  = 0.5,    -- seconds of meter regained per second
    focusMinStart  = 1.0,    -- need at least this much meter to start
    focusLookScale = 0.25,   -- his mouse/stick look speed while focusing (1.0 = unchanged)

    -- Quickhacks
    hostCanHack    = false,  -- false = only Peri can hack (the host app can change this)

    -- ULTIMATE "OVERRIDE": radar of everything around V, hacks cost no RAM, time slows
    ultDuration    = 6.0,    -- seconds (real time)
    ultCooldown    = 60.0,
    ultRadius      = 40,     -- meters around V
    ultDilation    = 0.1,    -- world speed during the ultimate
    ultHurtPercent = 10,     -- V loses this % of max health when it starts...
    ultHealthFloor = 10,     -- ...but never drops below this % (never fatal)

    -- EXPERIMENTAL: Peri's own cyberdeck, used when he isn't wearing one (host app toggles it)
    virtualEnabled = false,
    vramBase       = 4,      -- Peri's max RAM = vramBase + his level * vramPerLevel
    vramPerLevel   = 0.3,
    vramRegen      = 0.5,    -- RAM regained per second
    maxHackRange   = 60,     -- meters
    throughWalls   = true,   -- Peri can target NPCs/devices hidden behind walls (anything in his view cone)
    pickRadius     = 0.10,   -- how close (fraction of screen height) a click must be to an enemy
    flipY          = true,   -- VERIFY: flip if markers appear upside down

    -- Virus window (fraction of screen) — top-right, left of the minimap
    windowX        = 0.61,
    windowY        = 0.04,
    windowW        = 0.23,
    fontScale      = 1.3,
    maxMessages    = 4,

    -- Runtime state (don't edit)
    focusLeft      = 6.0,
    focusHeld      = false,
    menu           = nil,    -- open hack menu: { seq, target, name, x, y, items }
    menuSeq        = 0,
    showHud        = true,
    scriptsOk      = nil,    -- is PeriLink.reds loaded? (checked on first use)
    deck           = {},     -- his equipped quickhacks: { {name, cost, tier, ultimate}, ... }
    ram            = { 0, 0 },
    virtualActive  = false,  -- experimental deck in use right now (enabled + no cyberdeck)
    ultLeft        = 0,      -- seconds of ultimate remaining
    ultCdLeft      = 0,
    ultTargets     = {},     -- id -> { obj, kind, name } while the ultimate is active
    ultList        = {},     -- what Peri's radar shows: { {id, name, kind, x, y} }
    aim            = nil,    -- what's under Peri's mouse: { id, name, kind, costs = { {cost, usable}, ... } }
    tags           = {},     -- while focusing: name tags of every target on screen { {id, name, kind, x, y} }
    tagTargets     = {},     -- id -> { obj, kind, name } for those tags
    nameCache      = {},     -- id -> display name (looking names up isn't free)
    aimAt          = 0,      -- when aim was last computed (os.clock)
    vram           = 4,
    vramMax        = 4,
}

-- Operator icons (pixel data generated by NeuralLink)
local okIcons, ICONS = pcall(require, "icons")
if not okIcons or type(ICONS) ~= "table" then ICONS = {} end
local iconsBroken = false

local INBOX         = "inbox.txt"
local POLL_INTERVAL = 0.2
local pollTimer     = 0
local lastId        = 0
local messages      = {}
local markers       = {}

local OUTBOX         = "state.json"
local STATE_INTERVAL = 0.5
local ultTimer       = 0
local tagTimer       = 0
local stateTimer     = 0
local lastStateText  = ""
local results        = {}   -- recent hack results for Peri's app: { {seq, ok, text}, ... }
local resultSeq      = 0

local GLITCH_CHARS = { "#", "%", "&", "@", "$", "!", "?", "*", "/", "0", "1" }

---------------------------------------------------------------------------
-- Virus message feed
---------------------------------------------------------------------------

local function utf8Chars(s)
    local chars = {}
    for ch in s:gmatch("[%z\1-\127\194-\244][\128-\191]*") do
        chars[#chars + 1] = ch
    end
    return chars
end

-- icon: which Operator icon this message was sent with (each message keeps its own)
local function pushMessage(text, kind, icon)
    local chars = utf8Chars(text)
    table.insert(messages, {
        chars    = chars,
        kind     = kind or "chat",
        icon     = icon,
        age      = 0,
        lifetime = 8 + #chars * 0.05,
    })
    while #messages > Coop.maxMessages do table.remove(messages, 1) end
    print("[CoopOperator] " .. text)
end

local function renderText(msg)
    local total = #msg.chars
    local shown = math.min(total, math.floor(msg.age * 45))
    local parts = {}
    for i = 1, shown do parts[#parts + 1] = msg.chars[i] end
    if shown < total then
        for _ = 1, math.min(2, total - shown) do
            parts[#parts + 1] = GLITCH_CHARS[math.random(#GLITCH_CHARS)]
        end
    end
    return table.concat(parts)
end

local function addMarker(x, y, label, kind)
    table.insert(markers, { x = x, y = y, label = label, kind = kind, age = 0, lifetime = 1.6 })
end

---------------------------------------------------------------------------
-- Is there a world to touch?
-- On the main menu, loading screens and while the game is paused, V and the world aren't
-- (fully) there. Asking the game about them then can crash it, so all world work waits.
---------------------------------------------------------------------------

-- worldExists: a save is loaded (V and the world are real), maybe paused.
-- worldReady:  ...and not paused: safe to hack, aim, slow time.
-- On the main menu the game can hand back a half-built V that isn't nil, so
-- Game.GetPlayer() alone is NOT enough (that crashed the game in 0.6.7).
local worldReady, worldExists = false, false

local function checkWorld()
    local ok, exists, paused = pcall(function()
        local sys = Game.GetSystemRequestsHandler()
        if not sys or sys:IsPreGame() then return false, false end
        return Game.GetPlayer() ~= nil, sys:IsGamePaused()
    end)
    if not ok then return false, false end
    return exists == true and not paused, exists == true
end

---------------------------------------------------------------------------
-- Finding enemies on screen
---------------------------------------------------------------------------

-- World position -> screen fraction (0..1), or nil if off screen
local function projectToScreen(worldPos)
    local ok, p = pcall(function()
        return Game.GetCameraSystem():ProjectPoint(worldPos)  -- VERIFY
    end)
    if not ok or not p then return nil end
    local x = (p.x + 1) / 2
    local y = Coop.flipY and (1 - p.y) / 2 or (p.y + 1) / 2
    if x < 0 or x > 1 or y < 0 or y > 1 then return nil end
    return x, y
end

-- Hackable things the game considers visible to V: NPCs, devices
-- (cameras, turrets, doors, vending machines...) and vehicles (with his perk). Returns { {obj, kind}, ... }
-- everything = true: all targets within radius around V (the ultimate), not just in view
local function getVisibleTargets(everything, radius)
    local list, seen = {}, {}
    local player = Game.GetPlayer()
    if not player then return list end

    local function add(obj, kind)
        local key = tostring(obj:GetEntityID().hash)
        if not seen[key] then
            seen[key] = true
            list[#list + 1] = { obj = obj, kind = kind }
        end
    end

    local function query(tsq, accept)   -- VERIFY: TSQ + GetTargetParts
        pcall(function()
            tsq.maxDistance = radius or Coop.maxHackRange
            if everything then
                pcall(function() tsq.testedSet = TargetingSet.Complete end)   -- VERIFY
            elseif Coop.throughWalls then
                -- Frustum = everything in the camera's view cone, even behind walls
                -- (the default only returns things in clear line of sight)
                pcall(function() tsq.testedSet = TargetingSet.Frustum end)
            end
            local success, parts = Game.GetTargetingSystem():GetTargetParts(player, tsq)
            if not success or not parts then return end
            for _, part in ipairs(parts) do
                local obj = part:GetComponent():GetEntity()
                if obj then
                    local kind = accept(obj)
                    if kind then add(obj, kind) end
                end
            end
        end)
    end

    query(TSQ_NPC(), function(obj)
        if obj:IsNPC() and not obj:IsDead() then return "npc" end
    end)
    query(TSQ_ALL(), function(obj)
        local ok, yes = pcall(function() return obj:IsDevice() and obj:IsQuickHackAble() end)
        if ok and yes then return "device" end
        -- cars and bikes: only once he has the Intelligence vehicle-hacking perk (PeriLink.reds checks)
        ok, yes = pcall(function() return obj:IsVehicle() and obj:PeriLinkHackable() end)
        if ok and yes then return "device" end
    end)
    return list
end

-- The visible target closest to screen point (sx, sy). kind: "npc", "device" or nil for either.
local function getTargetNear(sx, sy, kind)
    local w, h = GetDisplayResolution()
    local aspect = w / h
    local best, bestDist, bestX, bestY, bestKind = nil, Coop.pickRadius, nil, nil, nil

    for _, t in ipairs(getVisibleTargets()) do
        if not kind or t.kind == kind then
            local pos = t.obj:GetWorldPosition()
            local lift = t.kind == "npc" and 1.2 or 0.0      -- aim at the chest, devices at their pivot
            local x, y = projectToScreen(Vector4.new(pos.x, pos.y, pos.z + lift, 1))
            if x then
                local dx = (x - sx) * aspect
                local dy = y - sy
                local dist = math.sqrt(dx * dx + dy * dy)
                if dist < bestDist then
                    best, bestDist, bestX, bestY, bestKind = t.obj, dist, x, y, t.kind
                end
            end
        end
    end
    return best, bestX, bestY, bestKind
end

local function getEnemyNear(sx, sy)
    return getTargetNear(sx, sy, "npc")
end

---------------------------------------------------------------------------
-- Abilities
---------------------------------------------------------------------------

-- mode 1 = burst (V full speed), mode 2 = focus (everything slows). See PeriLink.reds.
local function setSlow(mode, on, dilation)
    -- the time system only exists inside a loaded game; touching it on the main menu crashes
    if not worldExists or (on and not worldReady) then return false end
    local player = Game.GetPlayer()
    if not player then return false end
    local ok, res = pcall(function() return PeriLinkApi.Slow(player, mode, on, dilation or 1.0) end)
    return ok and res
end

---------------------------------------------------------------------------
-- Slow look: while Peri focuses, his camera turns slower too.
-- Time dilation doesn't touch mouse look, so we lower his look sensitivity in the
-- game's settings and put it back afterwards. The original values are written to
-- look-restore.txt first, so a crash mid-focus gets fixed on the next start.
---------------------------------------------------------------------------

local LOOK_RESTORE = "look-restore.txt"
local lookSaved = nil   -- { {group, name, kind, value}, ... } while slowed
local lookReported = false

local function lookVars()
    local out = {}
    pcall(function()
        local settings = Game.GetSettingsSystem()
        local root = settings and settings:GetGroup("/controls")
        if not root then return end
        local function walk(group, depth)
            if depth > 3 then return end
            local path = NameToString(group:GetPath()):lower()
            local isLook = path:find("camera") and (path:find("mouse") or path:find("pad") or path:find("controller"))
            if isLook then
                for _, v in ipairs(group:GetVars(false) or {}) do
                    local name = NameToString(v:GetName())
                    local low = name:lower()
                    local skip = low:find("invert") or low:find("smooth") or low:find("accel")
                              or low:find("dead") or low:find("curve") or low:find("aim")
                    if not skip then
                        if v:IsA("ConfigVarFloat") then table.insert(out, { v = v, group = NameToString(group:GetPath()), name = name, kind = "f" })
                        elseif v:IsA("ConfigVarInt") then table.insert(out, { v = v, group = NameToString(group:GetPath()), name = name, kind = "i" }) end
                    end
                end
            end
            for _, g in ipairs(group:GetGroups(false) or {}) do walk(g, depth + 1) end
        end
        walk(root, 0)
    end)
    return out
end

local function confirmSettings()
    pcall(function()
        local settings = Game.GetSettingsSystem()
        if settings:NeedsConfirmation() then settings:ConfirmChanges() end
    end)
end

local function restoreLook()
    local saved = lookSaved
    if not saved then
        -- nothing in memory: maybe the game crashed mid-focus last time
        local f = io.open(LOOK_RESTORE, "r")
        if not f then return end
        saved = {}
        for line in f:lines() do
            local group, name, kind, value = line:match("^([^|]+)|([^|]+)|([fi])|(.+)$")
            if group then table.insert(saved, { group = group, name = name, kind = kind, value = tonumber(value) }) end
        end
        f:close()
    end
    pcall(function()
        local settings = Game.GetSettingsSystem()
        for _, s in ipairs(saved) do
            local v = settings:GetVar(s.group, s.name)
            if v and s.value then
                if s.kind == "i" then v:SetValue(math.floor(s.value + 0.5)) else v:SetValue(s.value) end
            end
        end
    end)
    confirmSettings()
    lookSaved = nil
    os.remove(LOOK_RESTORE)
end

local function slowLook()
    if lookSaved or Coop.focusLookScale >= 1.0 then return end
    local vars = lookVars()
    if not lookReported then
        lookReported = true
        local names = {}
        for _, e in ipairs(vars) do table.insert(names, e.name) end
        print("[CoopOperator] slow look settings: " .. (#names > 0 and table.concat(names, ", ") or "none found"))
    end
    if #vars == 0 then return end
    local lines = {}
    for _, e in ipairs(vars) do
        e.value = e.v:GetValue()
        table.insert(lines, string.format("%s|%s|%s|%s", e.group, e.name, e.kind, tostring(e.value)))
    end
    local f = io.open(LOOK_RESTORE, "w")
    if not f then return end      -- no restore file = no change; never risk leaving him slow
    f:write(table.concat(lines, "\n"))
    f:close()
    lookSaved = vars
    pcall(function()
        for _, e in ipairs(vars) do
            local target = e.value * Coop.focusLookScale
            local lo = e.v:GetMinValue()
            if e.kind == "i" then
                e.v:SetValue(math.max(lo, math.floor(target + 0.5)))
            else
                e.v:SetValue(math.max(lo, target))
            end
        end
    end)
    confirmSettings()
end

local function startFocus()
    if Coop.focusHeld or Coop.focusLeft < Coop.focusMinStart then return end
    if setSlow(2, true, Coop.focusDilation) then
        Coop.focusHeld = true
        slowLook()
    end
end

local function stopFocus()
    if not Coop.focusHeld then return end
    Coop.focusHeld = false
    setSlow(2, false)
    restoreLook()
end

---------------------------------------------------------------------------
-- Real quickhacks (through PeriLink.reds)
---------------------------------------------------------------------------

local function scriptsLoaded()
    if Coop.scriptsOk == nil then
        Coop.scriptsOk = pcall(function()
            assert(PeriLinkApi ~= nil and PeriLinkApi.DescribeDeck ~= nil)
        end)
        if not Coop.scriptsOk then
            print("[CoopOperator] PeriLink.reds not loaded — is redscript installed?")
        end
    end
    return Coop.scriptsOk
end

local function setResult(ok, text)
    resultSeq = resultSeq + 1
    table.insert(results, { seq = resultSeq, ok = ok, text = text })
    while #results > 6 do table.remove(results, 1) end
end

-- Read his deck + RAM (shown in Peri's app)
local function refreshDeck()
    if not worldReady then return end
    local player = Game.GetPlayer()
    if not player or not scriptsLoaded() then return end
    pcall(function()
        local deck = {}
        for _, line in ipairs(PeriLinkApi.DescribeDeck(player, Coop.virtualEnabled) or {}) do
            local name, cost, tier, ult = line:match("^(.-)|(%-?%d+)|(%-?%d+)|([01])$")
            if name then
                deck[#deck + 1] = { name = name, cost = tonumber(cost), tier = tonumber(tier), ultimate = ult == "1" }
            end
        end
        Coop.deck = deck
        local wasActive = Coop.virtualActive
        Coop.virtualActive = PeriLinkApi.UsingVirtual(player, Coop.virtualEnabled) == true
        if Coop.virtualActive then
            local level = PeriLinkApi.GetLevel(player) or 1
            Coop.vramMax = math.floor(Coop.vramBase + level * Coop.vramPerLevel)
            if not wasActive then Coop.vram = Coop.vramMax end      -- start full when the mode kicks in
            Coop.vram = math.min(Coop.vram, Coop.vramMax)
            Coop.ram = { Coop.vram, Coop.vramMax }
        else
            local ram = PeriLinkApi.GetRam(player)
            if ram then Coop.ram = { ram[1] or 0, ram[2] or 0 } end
        end
    end)
end

local function applyHostLock()
    if not worldReady then return end
    local player = Game.GetPlayer()
    if not player or not scriptsLoaded() then return end
    pcall(function() PeriLinkApi.SetHostCanHack(player, Coop.hostCanHack) end)
end

-- slot: 0-based index into his deck. sx, sy: where Peri clicked (0..1)
-- What PeriLink.reds answered ("ok|<hack>" or "fail|<reason>") -> HUD + Peri's app
local function handleHackResult(ok, res, fallbackName, tx, ty)
    if not ok or type(res) ~= "string" then
        setResult(false, fallbackName .. ": failed")
        pushMessage("> " .. fallbackName .. " failed", "system")
        return
    end
    local status, text = res:match("^(%a+)|(.*)$")
    if status == "ok" then
        -- "ok|<hack>|<cost>": in experimental mode the cost comes out of Peri's RAM
        local name, cost = text:match("^(.*)|(%d+)$")
        if name then
            text = name
            -- (free during the ultimate)
            if Coop.virtualActive and Coop.ultLeft <= 0 then Coop.vram = math.max(0, Coop.vram - tonumber(cost)) end
        end
        if tx then addMarker(tx, ty, text:upper(), "hack") end
        pushMessage("> " .. text:upper() .. " uploading", "system")
        setResult(true, text .. " uploading")
    else
        setResult(false, text or res)
    end
    refreshDeck()
    Coop.aimAt = 0   -- recompute hotbar costs (a hack may now be cooling down)
end

-- Open the game's own hack menu for the target nearest (sx, sy) — NPC or device.
-- Peri's app shows it and sends back a pick.
local function openMenu(sx, sy, target, tx, ty)
    if not scriptsLoaded() then
        setResult(false, "PeriLink scripts not installed on his PC")
        return
    end
    if not target and sx then
        target, tx, ty = getTargetNear(sx, sy, nil)
    end
    if not target then
        if sx then addMarker(sx, sy, "miss", "miss") end
        setResult(false, "Nothing hackable there")
        return
    end

    local ok = pcall(function()
        local items = {}
        for _, line in ipairs(target:PeriLinkMenu(Coop.virtualEnabled, Coop.ultLeft > 0) or {}) do
            local name, cost, locked, reason = line:match("^(.-)|(%-?%d+)|([01])|(.*)$")
            if name then
                items[#items + 1] = { name = name, cost = tonumber(cost), locked = locked == "1", reason = reason }
            end
        end
        Coop.menuSeq = Coop.menuSeq + 1
        Coop.menu = { seq = Coop.menuSeq, target = target, name = target:PeriLinkName(), x = tx, y = ty, items = items }
    end)
    if ok then
        if tx then addMarker(tx, ty, "SCANNING", "ping") end
    else
        setResult(false, "Couldn't read that target's hacks")
    end
end

local function pickFromMenu(seq, index, title)
    local menu = Coop.menu
    if not menu or menu.seq ~= seq then
        setResult(false, "That menu closed")
        return
    end
    Coop.menu = nil
    local ok, res = pcall(function()
        return menu.target:PeriLinkPick(index, title, Coop.virtualEnabled, math.floor(Coop.vram), Coop.ultLeft > 0)
    end)
    handleHackResult(ok, res, title ~= "" and title or "Hack", menu.x, menu.y)
end

-- slot: 0-based index into his deck. sx, sy: where Peri clicked (0..1)
-- Clicking a device (camera, turret...) opens its menu instead: deck slots are for people.
local function castSlot(slot, sx, sy)
    if not scriptsLoaded() then
        pushMessage("> hacking offline (PeriLink.reds missing)", "system")
        setResult(false, "PeriLink scripts not installed on his PC")
        return
    end

    local hackName = Coop.deck[slot + 1] and Coop.deck[slot + 1].name or ("slot " .. (slot + 1))
    local target, tx, ty, kind = getTargetNear(sx, sy, nil)
    if not target then
        addMarker(sx, sy, "miss", "miss")
        setResult(false, "No target there")
        return
    end
    if kind == "device" then
        openMenu(sx, sy, target, tx, ty)
        return
    end

    local ok, res = pcall(function()
        return target:PeriLinkCast(slot, Coop.virtualEnabled, math.floor(Coop.vram), Coop.ultLeft > 0)
    end)
    handleHackResult(ok, res, hackName, tx, ty)
end

-- ---------------------------------------------------------------------------
-- Real hotbar costs for whatever is under Peri's mouse
-- ---------------------------------------------------------------------------

local function targetName(id, obj, kind)
    local name = Coop.nameCache[id]
    if not name then
        local ok, n = pcall(function() return obj:PeriLinkName() end)
        name = (ok and n and n ~= "") and n or (kind == "npc" and "Person" or "Device")
        Coop.nameCache[id] = name
    end
    return name
end

local updateAimTarget

local function updateAim(sx, sy)
    if not sx or not scriptsLoaded() then
        Coop.aim = nil
        return
    end
    local target, _, _, kind = getTargetNear(sx, sy, nil)
    updateAimTarget(target, kind)
end

updateAimTarget = function(target, kind)
    if not target or not scriptsLoaded() then
        Coop.aim = nil
        return
    end
    local id = tostring(target:GetEntityID().hash)
    -- Same target as before and fresh enough: keep it (building the list isn't free)
    if Coop.aim and Coop.aim.id == id and os.clock() - Coop.aimAt < 1.0 then return end

    local aim = { id = id, kind = kind, costs = {}, name = targetName(id, target, kind) }
    if kind == "npc" then
        pcall(function()
            for _, line in ipairs(target:PeriLinkSlotCosts(Coop.virtualEnabled, Coop.ultLeft > 0) or {}) do
                local cost, usable = line:match("^(%-?%d+)|([01])$")
                aim.costs[#aim.costs + 1] = { cost = tonumber(cost) or -1, usable = usable == "1" }
            end
        end)
    end
    Coop.aim, Coop.aimAt = aim, os.clock()
end

-- ---------------------------------------------------------------------------
-- ULTIMATE: OVERRIDE
-- ---------------------------------------------------------------------------

-- Everything hackable within ultRadius of V, as radar coordinates
-- (x = meters to V's right, y = meters in front of V)
local function refreshUltTargets()
    local player = Game.GetPlayer()
    if not player then return end
    local vpos = player:GetWorldPosition()
    local fwd = player:GetWorldForward()
    local fx, fy = fwd.x, fwd.y
    local len = math.sqrt(fx * fx + fy * fy)
    if len < 0.001 then fx, fy, len = 0, 1, 1 end
    fx, fy = fx / len, fy / len

    local found = getVisibleTargets(true, Coop.ultRadius)
    local targets, list = {}, {}
    for _, t in ipairs(found) do
        local ok = pcall(function()
            local id = tostring(t.obj:GetEntityID().hash)
            local p = t.obj:GetWorldPosition()
            local dx, dy = p.x - vpos.x, p.y - vpos.y
            local ahead = dx * fx + dy * fy
            local right = dx * fy - dy * fx
            if dx * dx + dy * dy <= Coop.ultRadius * Coop.ultRadius then
                local name = targetName(id, t.obj, t.kind)
                -- How dangerous it is right now + hacks already on it, straight from the game
                -- ("red|0.40|Short Circuit,Overheat"). Older scripts: every NPC counts as red.
                local threat, up, effects = (t.kind == "device") and "device" or "red", 0, {}
                if t.kind == "npc" then
                    local okT, info = pcall(function() return t.obj:PeriLinkThreat() end)
                    if okT and type(info) == "string" then
                        local th, upv, fxs = info:match("^(%a+)|([%d%.]+)|(.*)$")
                        if th then
                            threat, up = th, tonumber(upv) or 0
                            for f in fxs:gmatch("[^,]+") do effects[#effects + 1] = f end
                        end
                    end
                end
                if threat ~= "dead" then
                    targets[id] = { obj = t.obj, kind = t.kind, name = name }
                    list[#list + 1] = { id = id, name = name, kind = t.kind, x = right, y = ahead,
                        threat = threat, up = up, fx = effects, d = math.sqrt(dx * dx + dy * dy) }
                end
            end
        end)
        if not ok then -- skip targets that vanish mid-read
        end
    end
    Coop.ultTargets, Coop.ultList = targets, list
end

local function startUltimate()
    if Coop.ultLeft > 0 then return end
    if not scriptsLoaded() then
        setResult(false, "Ultimate offline (PeriLink scripts missing)")
        return
    end
    if Coop.ultCdLeft > 0 then
        setResult(false, string.format("OVERRIDE recharging (%.0fs)", Coop.ultCdLeft))
        return
    end
    local player = Game.GetPlayer()
    if not player then return end
    setSlow(3, true, Coop.ultDilation)
    pcall(function() PeriLinkApi.Hurt(player, Coop.ultHurtPercent, Coop.ultHealthFloor) end)
    Coop.ultLeft = Coop.ultDuration
    refreshUltTargets()
    pushMessage("> OVERRIDE.exe — your mind is mine for " .. math.floor(Coop.ultDuration) .. "s", "system")
    setResult(true, "OVERRIDE active")
end

local function stopUltimate()
    setSlow(3, false)
    Coop.ultLeft = 0
    Coop.ultCdLeft = Coop.ultCooldown
    Coop.ultTargets, Coop.ultList = {}, {}
    if Coop.focusHeld then setSlow(2, true, Coop.focusDilation) end   -- focus still held
end

-- Name tags while Peri focuses: every target on his screen, with its screen position
local function refreshTags()
    local tags, targets = {}, {}
    for _, t in ipairs(getVisibleTargets(false)) do
        pcall(function()
            local pos = t.obj:GetWorldPosition()
            local lift = t.kind == "npc" and 1.2 or 0.0
            local x, y = projectToScreen(Vector4.new(pos.x, pos.y, pos.z + lift, 1))
            if x then
                local id = tostring(t.obj:GetEntityID().hash)
                local name = targetName(id, t.obj, t.kind)
                targets[id] = { obj = t.obj, kind = t.kind, name = name }
                tags[#tags + 1] = { id = id, name = name, kind = t.kind, x = x, y = y }
            end
        end)
    end
    Coop.tags, Coop.tagTargets = tags, targets
end

-- Peri picked a target by id (a focus name tag or a radar dot). slot = nil opens its hack menu.
local function hackById(id, slot)
    local t = Coop.tagTargets[id] or Coop.ultTargets[id]
    if not t then
        setResult(false, "That target is gone")
        return
    end
    if t.kind == "device" or slot == nil then
        openMenu(nil, nil, t.obj, nil, nil)
        return
    end
    local hackName = Coop.deck[slot + 1] and Coop.deck[slot + 1].name or ("slot " .. (slot + 1))
    local ok, res = pcall(function()
        return t.obj:PeriLinkCast(slot, Coop.virtualEnabled, math.floor(Coop.vram), Coop.ultLeft > 0)
    end)
    handleHackResult(ok, res, hackName, nil, nil)
end

-- ---------------------------------------------------------------------------
-- State file for the app: his deck, RAM, last result
-- ---------------------------------------------------------------------------

local function jsonString(v)
    return '"' .. tostring(v):gsub('[%c"\\]', function(c)
        return string.format("\\u%04x", c:byte())
    end) .. '"'
end

local function writeState()
    local parts = {}
    for _, h in ipairs(Coop.deck) do
        parts[#parts + 1] = string.format('{"name":%s,"cost":%d,"tier":%d,"ultimate":%s}',
            jsonString(h.name), h.cost or 0, h.tier or 0, h.ultimate and "true" or "false")
    end
    local res = {}
    for _, r in ipairs(results) do
        res[#res + 1] = string.format('{"seq":%d,"ok":%s,"text":%s}', r.seq, tostring(r.ok), jsonString(r.text))
    end
    local menu = "null"
    if Coop.menu then
        local items = {}
        for _, it in ipairs(Coop.menu.items) do
            items[#items + 1] = string.format('{"name":%s,"cost":%d,"locked":%s,"reason":%s}',
                jsonString(it.name), it.cost or 0, tostring(it.locked), jsonString(it.reason or ""))
        end
        menu = string.format('{"seq":%d,"name":%s,"x":%.4f,"y":%.4f,"items":[%s]}',
            Coop.menu.seq, jsonString(Coop.menu.name or ""), Coop.menu.x or 0.5, Coop.menu.y or 0.5,
            table.concat(items, ","))
    end
    local targets = {}
    for _, t in ipairs(Coop.ultList) do
        local fxj = {}
        for _, f in ipairs(t.fx or {}) do fxj[#fxj + 1] = jsonString(f) end
        targets[#targets + 1] = string.format('{"id":%s,"name":%s,"kind":%s,"x":%.1f,"y":%.1f,"d":%.1f,"threat":%s,"up":%.2f,"fx":[%s]}',
            jsonString(t.id), jsonString(t.name), jsonString(t.kind), t.x, t.y, t.d or 0,
            jsonString(t.threat or "red"), t.up or 0, table.concat(fxj, ","))
    end
    local tagParts = {}
    for _, t in ipairs(Coop.tags) do
        tagParts[#tagParts + 1] = string.format('{"id":%s,"name":%s,"kind":%s,"x":%.4f,"y":%.4f}',
            jsonString(t.id), jsonString(t.name), jsonString(t.kind), t.x, t.y)
    end
    local ult = string.format('{"left":%.1f,"cd":%.1f,"duration":%.1f,"cooldown":%.1f,"radius":%d,"targets":[%s]}',
        Coop.ultLeft, Coop.ultCdLeft, Coop.ultDuration, Coop.ultCooldown, Coop.ultRadius, table.concat(targets, ","))
    local aim = "null"
    if Coop.aim then
        local costs = {}
        for _, c in ipairs(Coop.aim.costs) do
            costs[#costs + 1] = string.format('{"cost":%d,"usable":%s}', c.cost, tostring(c.usable))
        end
        aim = string.format('{"id":%s,"name":%s,"kind":%s,"costs":[%s]}',
            jsonString(Coop.aim.id), jsonString(Coop.aim.name or ""), jsonString(Coop.aim.kind or ""), table.concat(costs, ","))
    end
    local text = string.format(
        '{"scripts":%s,"hostCanHack":%s,"virtual":%s,"ram":[%.1f,%.1f],"focus":[%.1f,%.1f,%s],"ult":%s,"aim":%s,"tags":[%s],"deck":[%s],"menu":%s,"results":[%s]}',
        tostring(Coop.scriptsOk == true), tostring(Coop.hostCanHack), tostring(Coop.virtualActive),
        Coop.virtualActive and Coop.vram or (Coop.ram[1] or 0), Coop.ram[2] or 0,
        Coop.focusLeft, Coop.focusMax, tostring(Coop.focusHeld), ult, aim, table.concat(tagParts, ","),
        table.concat(parts, ","), menu, table.concat(res, ","))
    if text == lastStateText then return end
    local f = io.open(OUTBOX, "w")
    if f then
        f:write(text)
        f:close()
        lastStateText = text
    end
end

---------------------------------------------------------------------------
-- Inbox (written by the NeuralLink host app). Each line: <id>|<command>|<argument>
---------------------------------------------------------------------------

local function parsePoint(arg)
    local x, y = arg:match("([%d%.]+)%s+([%d%.]+)")
    x, y = tonumber(x), tonumber(y)
    if x and y and x >= 0 and x <= 1 and y >= 0 and y <= 1 then return x, y end
    return nil
end

local WORLD_COMMANDS = { hack = true, menu = true, pick = true, focus = true, aim = true, ult = true, ulthack = true, ultmenu = true, aimid = true }

local function handleCommand(cmd, arg)
    if WORLD_COMMANDS[cmd] and not worldReady then
        -- main menu / loading / paused: chat and pings still work, hacking waits
        if cmd == "hack" or cmd == "menu" or cmd == "ult" or cmd == "ulthack" or cmd == "ultmenu" then
            setResult(false, "Not in the game right now (menu / loading / paused)")
        end
        if cmd == "focus" and arg ~= "1" then Coop.focusHeld = false; restoreLook() end
        return
    end
    if cmd == "say" then
        -- arg is "<icon>|<name>|<text>" (older senders: just "<text>")
        local icon, name, text = arg:match("^([%w_]*)|([^|]*)|(.*)$")
        if not icon then text = arg end
        if icon and ICONS[icon] then Coop.callerIcon = icon end
        if name and name ~= "" then Coop.callerName = name end
        if text and text ~= "" then pushMessage(text, "chat", Coop.callerIcon) end
    elseif cmd == "ping" then
        local x, y = parsePoint(arg)
        if x then addMarker(x, y, "LOOK", "ping") end
    elseif cmd == "hack" then
        local slot, rest = arg:match("^(%d+)%s+(.*)$")
        local x, y = parsePoint(rest or "")
        if slot and x then castSlot(tonumber(slot), x, y) end
    elseif cmd == "menu" then
        local x, y = parsePoint(arg)
        if x then openMenu(x, y) end
    elseif cmd == "pick" then
        local seq, index, title = arg:match("^(%d+)%s+(%d+)%s?(.*)$")
        if seq then pickFromMenu(tonumber(seq), tonumber(index), title or "") end
    elseif cmd == "menuclose" then
        Coop.menu = nil
    elseif cmd == "focus" then
        if arg == "1" then startFocus() else stopFocus() end
    elseif cmd == "aim" then
        updateAim(parsePoint(arg))
        writeState()
    elseif cmd == "ult" then
        startUltimate()
    elseif cmd == "ulthack" then
        local id, slot = arg:match("^(%S+)%s+(%d+)$")
        if id then hackById(id, tonumber(slot)) end
    elseif cmd == "ultmenu" then
        local id = arg:match("^(%S+)$")
        if id then hackById(id, nil) end
    elseif cmd == "aimid" then
        local t = Coop.tagTargets[arg] or Coop.ultTargets[arg]
        updateAimTarget(t and t.obj, t and t.kind)
        writeState()
    elseif cmd == "virtual" then
        Coop.virtualEnabled = (arg == "1")
        refreshDeck()
    elseif cmd == "lock" then
        Coop.hostCanHack = (arg == "1")
        applyHostLock()
    end
end

local function readInbox(process)
    local f = io.open(INBOX, "r")
    if not f then return end
    local content = f:read("*a")
    f:close()
    for line in content:gmatch("[^\r\n]+") do
        local id, cmd, arg = line:match("^(%d+)|(%w+)|(.*)$")
        id = tonumber(id)
        if id and id > lastId then
            lastId = id
            if process then handleCommand(cmd, arg) end
        end
    end
end

---------------------------------------------------------------------------
-- Drawing
---------------------------------------------------------------------------

local NO_INPUT_FLAGS = ImGuiWindowFlags.NoTitleBar + ImGuiWindowFlags.NoResize
                     + ImGuiWindowFlags.NoMove + ImGuiWindowFlags.NoScrollbar
                     + ImGuiWindowFlags.NoCollapse + ImGuiWindowFlags.NoInputs
                     + ImGuiWindowFlags.NoFocusOnAppearing + ImGuiWindowFlags.NoNav

-- Draws an Operator icon as filled rectangles (CET can't load image files),
-- reserving the space in the layout. variant: "big" (header) or "small" (per message).
-- alpha < 1 fades it out together with its message. Returns false if it couldn't draw.
local function drawIcon(id, variant, size, alpha)
    local entry = ICONS[id]
    local icon = entry and entry[variant]
    if not icon or iconsBroken then return false end
    alpha = alpha or 1.0

    local ok = pcall(function()
        local dl = ImGui.GetWindowDrawList()
        local x0, y0 = ImGui.GetCursorScreenPos()
        local scale = size / icon.size
        for ry, runs in ipairs(icon.rows) do
            local top = math.floor(y0 + (ry - 1) * scale)
            local bottom = math.floor(y0 + ry * scale)
            for i = 1, #runs, 3 do
                local rx, len, col = runs[i], runs[i + 1], runs[i + 2]
                ImGui.ImDrawListAddRectFilled(dl,
                    math.floor(x0 + rx * scale), top,
                    math.floor(x0 + (rx + len) * scale), bottom,
                    col)
            end
        end
        -- fade: cover with the window's dark color instead of recoloring every square
        if alpha < 1.0 then
            local a = math.floor((1.0 - alpha) * 255)
            ImGui.ImDrawListAddRectFilled(dl, x0, y0, x0 + size, y0 + size, a * 16777216 + 0x05000F)
        end
        -- thin red frame
        local frameA = math.floor(204 * alpha)
        ImGui.ImDrawListAddRect(dl, x0 - 1, y0 - 1, x0 + size + 1, y0 + size + 1, frameA * 16777216 + 0x4E3BFF)
    end)

    if not ok then
        iconsBroken = true   -- VERIFY: draw-list functions missing in this CET version
        print("[CoopOperator] could not draw icons; showing names only")
        return false
    end
    ImGui.Dummy(size, size)
    return true
end

local function drawVirusWindow()
    local w, h = GetDisplayResolution()
    ImGui.SetNextWindowPos(w * Coop.windowX, h * Coop.windowY, ImGuiCond.Always)
    ImGui.SetNextWindowSize(w * Coop.windowW, 0, ImGuiCond.Always)

    ImGui.PushStyleColor(ImGuiCol.WindowBg, 0.06, 0.0, 0.02, 0.55)
    ImGui.PushStyleColor(ImGuiCol.Border, 1.0, 0.2, 0.25, 0.6)

    if ImGui.Begin("##CoopOperatorVirus", NO_INPUT_FLAGS) then
        ImGui.SetWindowFontScale(Coop.fontScale)

        -- Call header: icon + name, like an incoming holocall
        local hasIcon = drawIcon(Coop.callerIcon, "big", math.floor(h * Coop.iconSize), 1.0)
        if hasIcon then
            ImGui.SameLine()
            ImGui.BeginGroup()
        end
        ImGui.PushStyleColor(ImGuiCol.Text, 0.24, 1.0, 0.48, 1.0)   -- icon green
        ImGui.Text(Coop.callerName)
        ImGui.PopStyleColor(1)
        local flicker = (math.random() < 0.04) and 0.4 or 1.0
        ImGui.PushStyleColor(ImGuiCol.Text, 1.0, 0.25, 0.3, flicker)
        ImGui.Text("CONNECTION: INSIDE YOUR HEAD")
        ImGui.PopStyleColor(1)

        local hack = (Coop.scriptsOk == false) and "HACK offline"
            or string.format(Coop.virtualActive and "PERI RAM %d/%d" or "RAM %d/%d",
                math.floor(Coop.virtualActive and Coop.vram or (Coop.ram[1] or 0)), math.floor(Coop.ram[2] or 0))
        ImGui.PushStyleColor(ImGuiCol.Text, 0.6, 0.6, 0.6, 0.8)
        local focus = Coop.focusHeld and "FOCUS" or string.format("FOCUS %d%%", math.floor(Coop.focusLeft / Coop.focusMax * 100))
        local ult
        if Coop.ultLeft > 0 then ult = string.format("OVERRIDE %.1fs", Coop.ultLeft)
        elseif Coop.ultCdLeft > 0 then ult = string.format("ULT %ds", math.ceil(Coop.ultCdLeft))
        else ult = "ULT ready" end
        ImGui.Text(hack .. "   " .. focus .. "   " .. ult)
        ImGui.PopStyleColor(1)
        if hasIcon then ImGui.EndGroup() end

        if #messages > 0 then ImGui.Separator() end
        for _, msg in ipairs(messages) do
            local alpha = math.min(1.0, (msg.lifetime - msg.age) / 1.5)

            -- small icon in front of chat messages, the one it was sent with
            local withIcon = msg.kind == "chat" and msg.icon
                and drawIcon(msg.icon, "small", math.floor(h * Coop.smallIconSize), alpha)
            if withIcon then
                ImGui.SameLine()
                ImGui.BeginGroup()   -- keeps wrapped lines lined up after the icon
            end

            if msg.kind == "system" then
                ImGui.PushStyleColor(ImGuiCol.Text, 0.98, 0.9, 0.3, alpha)
            else
                ImGui.PushStyleColor(ImGuiCol.Text, 1.0, 0.82, 0.84, alpha)
            end
            ImGui.TextWrapped(renderText(msg))
            ImGui.PopStyleColor(1)

            if withIcon then ImGui.EndGroup() end
        end
    end
    ImGui.End()
    ImGui.PopStyleColor(2)
end

-- Small floating labels where the Operator hacked / pinged
local function drawMarkers()
    local w, h = GetDisplayResolution()
    for i, m in ipairs(markers) do
        local alpha = math.min(1.0, (m.lifetime - m.age) / 0.6)
        local r, g, b = 1.0, 0.25, 0.3              -- hack: red
        if m.kind == "ping" then r, g, b = 0.35, 0.95, 0.9 end  -- ping: cyan
        if m.kind == "miss" then r, g, b = 0.6, 0.6, 0.6 end

        ImGui.SetNextWindowPos(w * m.x - 40, h * m.y - 20, ImGuiCond.Always)
        ImGui.SetNextWindowBgAlpha(0)
        if ImGui.Begin("##CoopMarker" .. i, NO_INPUT_FLAGS + ImGuiWindowFlags.AlwaysAutoResize) then
            ImGui.SetWindowFontScale(Coop.fontScale)
            ImGui.PushStyleColor(ImGuiCol.Text, r, g, b, alpha)
            ImGui.Text("[ + ]  " .. m.label)
            ImGui.PopStyleColor(1)
        end
        ImGui.End()
    end
end

---------------------------------------------------------------------------
-- CET events
---------------------------------------------------------------------------

-- Host-side hotkeys: only harmless ones. Hacks and slow-mo belong to Peri.
registerHotkey("coop_test", "Co-op: Test Peri's message window", function()
    pushMessage("wake up, samurai. it's me, in your head.", "chat", Coop.callerIcon)
end)
registerHotkey("coop_hud",  "Co-op: Show/hide Peri's window", function() Coop.showHud = not Coop.showHud end)

registerForEvent("onInit", function()
    readInbox(false)  -- ignore anything sent before the game started
    restoreLook()     -- undo a slowed look left behind by a crash mid-focus
    print("[CoopOperator] loaded")
end)

-- The world went away (main menu, loading, pause): let go of every game object we hold
-- and stop slow-motion, so nothing points at things the game is unloading.
local function leaveWorld()
    setSlow(2, false)       -- (does nothing if V is already gone)
    setSlow(3, false)
    if Coop.focusHeld then Coop.focusHeld = false end
    restoreLook()           -- pause menu / main menu: his real sensitivity, always
    if Coop.ultLeft > 0 then Coop.ultLeft = 0 end
    Coop.tags, Coop.tagTargets = {}, {}
    Coop.ultTargets, Coop.ultList = {}, {}
    Coop.menu = nil
    Coop.aim = nil
    writeState()
end

registerForEvent("onUpdate", function(dt)
    local ready, exists = checkWorld()
    if worldReady and not ready then
        worldExists = exists          -- leaving to the main menu: don't touch the time system anymore
        leaveWorld()
    end
    worldReady, worldExists = ready, exists

    pollTimer = pollTimer + dt
    if pollTimer >= POLL_INTERVAL then
        pollTimer = 0
        readInbox(true)
    end

    -- Peri's experimental RAM refills over time
    if Coop.vram < Coop.vramMax then
        Coop.vram = math.min(Coop.vramMax, Coop.vram + Coop.vramRegen * dt)
    end

    -- Focus drains while Peri holds it, refills when released
    if Coop.focusHeld then
        Coop.focusLeft = Coop.focusLeft - dt
        if Coop.focusLeft <= 0 then
            Coop.focusLeft = 0
            stopFocus()
        end
    elseif Coop.focusLeft < Coop.focusMax then
        Coop.focusLeft = math.min(Coop.focusMax, Coop.focusLeft + Coop.focusRecharge * dt)
    end

    -- Focus: keep name tags over every target on screen
    if Coop.focusHeld and Coop.ultLeft <= 0 and worldReady then
        tagTimer = tagTimer + dt
        if tagTimer >= 0.25 then
            tagTimer = 0
            refreshTags()
            writeState()
        end
    elseif #Coop.tags > 0 then
        Coop.tags, Coop.tagTargets = {}, {}
        writeState()
    end

    -- Ultimate: count down, keep the radar fresh, and keep the slow-down applied
    if Coop.ultLeft > 0 and worldReady then
        Coop.ultLeft = Coop.ultLeft - dt
        ultTimer = ultTimer + dt
        if Coop.ultLeft <= 0 then
            stopUltimate()
            writeState()
        elseif ultTimer >= 0.25 then
            ultTimer = 0
            refreshUltTargets()
            setSlow(3, true, Coop.ultDilation)
            writeState()
        end
    elseif Coop.ultCdLeft > 0 then
        Coop.ultCdLeft = math.max(0, Coop.ultCdLeft - dt)
    end

    -- Share his deck/RAM with the app, and keep the hacking lock applied
    -- (it resets when a save is loaded)
    stateTimer = stateTimer + dt
    if stateTimer >= STATE_INTERVAL then
        stateTimer = 0
        refreshDeck()
        applyHostLock()
        -- Safety net: keep focus applied while Peri holds it, in case the game cancels it
        if Coop.focusHeld and worldReady then setSlow(2, true, Coop.focusDilation) end
        writeState()
    end

    for i = #messages, 1, -1 do
        messages[i].age = messages[i].age + dt
        if messages[i].age >= messages[i].lifetime then table.remove(messages, i) end
    end
    for i = #markers, 1, -1 do
        markers[i].age = markers[i].age + dt
        if markers[i].age >= markers[i].lifetime then table.remove(markers, i) end
    end
end)

registerForEvent("onDraw", function()
    if not Coop.showHud then return end
    drawVirusWindow()
    drawMarkers()
end)

registerForEvent("onShutdown", function()
    setSlow(2, false)
    setSlow(3, false)
    restoreLook()
end)
