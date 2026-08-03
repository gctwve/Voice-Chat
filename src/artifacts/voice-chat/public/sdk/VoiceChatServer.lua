--[[
    VoiceChatServer.lua — Giwivc Voice Chat Server SDK
    Loaded automatically by VCLoader via loadstring().
    Do NOT modify this file — update it by reloading the URL.

    Creates all required ReplicatedStorage instances:
      StringValues : VoiceChatRoomId, VoiceChatToken_{userId}
      RemoteEvents : UpdateVoicePosition, ConnectionStatus,
                     VoiceMuteEvent, UpdateSpeakingStatus, ShowWarning
]]

-- Config
local BASE_URL  = "https://giwivc.replit.app"
local POLL_RATE = 1

-- Services
local Players           = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local HttpService       = game:GetService("HttpService")

-- Helper: create or get a ReplicatedStorage instance
local function ensure(className, name, parent)
    local existing = parent:FindFirstChild(name)
    if existing and existing.ClassName == className then
        return existing
    end
    if existing then
        existing:Destroy()
    end
    local inst    = Instance.new(className)
    inst.Name     = name
    inst.Parent   = parent
    return inst
end

local function httpPost(path, payload)
    return pcall(function()
        return HttpService:PostAsync(
            BASE_URL .. path,
            HttpService:JSONEncode(payload),
            Enum.HttpContentType.ApplicationJson,
            false
        )
    end)
end

local function httpGet(path)
    return pcall(function()
        return HttpService:GetAsync(BASE_URL .. path, true)
    end)
end

-- Create RemoteEvents and StringValues
local roomIdValue           = ensure("StringValue", "VoiceChatRoomId",     ReplicatedStorage)
local updatePositionEvent   = ensure("RemoteEvent", "UpdateVoicePosition",  ReplicatedStorage)
local connectionStatusEvent = ensure("RemoteEvent", "ConnectionStatus",     ReplicatedStorage)
local muteEvent             = ensure("RemoteEvent", "VoiceMuteEvent",       ReplicatedStorage)
local speakingStatusEvent   = ensure("RemoteEvent", "UpdateSpeakingStatus", ReplicatedStorage)
ensure("RemoteEvent", "ShowWarning", ReplicatedStorage)

-- Fetch Room ID from voice server
local roomId

local ok, result = httpPost("/api/rooms", {
    placeId = tostring(game.PlaceId),
    jobId   = tostring(game.JobId),
})

if ok then
    local data = HttpService:JSONDecode(result)
    roomId = data.roomId
else
    local job = string.sub(tostring(game.JobId), 1, 8)
    if job == "" then
        job = "studio"
    end
    roomId = tostring(game.PlaceId) .. "-" .. job
    warn("[VoiceChat] Could not reach server, using fallback room ID")
end

roomIdValue.Value = roomId
print("[VoiceChat] Room ID:", roomId)

-- Player state tables
local playerConnected = {}

-- Player join handler
local function onPlayerAdded(player)
    local userId = tostring(player.UserId)

    local tokenValue = ensure("StringValue", "VoiceChatToken_" .. userId, ReplicatedStorage)
    tokenValue.Value = userId

    playerConnected[userId] = false
    connectionStatusEvent:FireClient(player, false)

    print("[VoiceChat]", player.Name, "joined — token:", userId)
end

-- Player leave handler
local function onPlayerRemoving(player)
    local userId = tostring(player.UserId)
    playerConnected[userId] = nil

    local tokenValue = ReplicatedStorage:FindFirstChild("VoiceChatToken_" .. userId)
    if tokenValue then
        tokenValue:Destroy()
    end
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, player in ipairs(Players:GetPlayers()) do
    spawn(function()
        onPlayerAdded(player)
    end)
end

-- Forward position updates to the voice server
updatePositionEvent.OnServerEvent:Connect(function(player, position, lookVector)
    local userId = tostring(player.UserId)
    httpPost("/api/position", {
        userId   = userId,
        roomId   = roomId,
        position = { x = position.X,   y = position.Y,   z = position.Z   },
        look     = { x = lookVector.X, y = lookVector.Y, z = lookVector.Z },
    })
end)

-- Handle mute events from client (tracked server-side if needed)
muteEvent.OnServerEvent:Connect(function(player, isMuted)
    print("[VoiceChat]", player.Name, "muted:", tostring(isMuted))
end)

-- Poll voice server for connection + speaking status
spawn(function()
    while true do
        wait(POLL_RATE)

        local pollOk, pollResult = httpGet("/api/rooms/" .. roomId .. "/status")

        if pollOk then
            local data = HttpService:JSONDecode(pollResult)
            local webUsers    = data.users    or {}
            local webSpeakers = data.speakers or {}

            -- Build lookup sets
            local connectedSet = {}
            for _, uid in ipairs(webUsers) do
                connectedSet[uid] = true
            end

            -- Update ConnectionStatus per player
            for _, player in ipairs(Players:GetPlayers()) do
                local userId   = tostring(player.UserId)
                local isNowConn = connectedSet[userId] == true

                if isNowConn ~= playerConnected[userId] then
                    playerConnected[userId] = isNowConn
                    connectionStatusEvent:FireClient(player, isNowConn)
                end
            end

            -- Broadcast speaker list
            speakingStatusEvent:FireAllClients(webSpeakers)
        end
    end
end)

print("[VoiceChat] Server SDK loaded successfully")
