--[[
    VoiceChatClient.lua — Giwivc Voice Chat
    Place this as a LocalScript inside StarterPlayerScripts.
    It runs automatically — no setup needed.

    Server script: https://giwivc.replit.app/sdk/VoiceChatServer.lua
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local GuiService        = game:GetService("GuiService")

-- Wait up to 10 seconds for the server to create the RemoteEvent
local openEvent = ReplicatedStorage:WaitForChild("OpenVoiceChat", 10)
if not openEvent then
    warn("[VoiceChat] OpenVoiceChat RemoteEvent not found — is VoiceChatServer.lua in ServerScriptService?")
    return
end

openEvent.OnClientEvent:Connect(function(url)
    GuiService:OpenBrowserWindow(url)
end)