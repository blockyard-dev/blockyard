# Set up a Discord bot token

Connect Blockyard to a Discord bot so your workflows can send messages, read channel history, and react to new messages.

> Treat a bot token like a password. Never post it, commit it to Git, or share it with anyone. If a token is exposed, reset it immediately in the Discord Developer Portal.

## 1. Create a Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select **New Application**.
3. Enter a name for your bot and select **Create**.

Discord creates a bot user for new applications automatically. If your application does not have one, open **Bot** in the sidebar and select **Add Bot**.

## 2. Copy the bot token

1. Open **Bot** in the application sidebar.
2. Under **Token**, select **Reset Token**.
3. Complete Discord's confirmation and copy the new token.
4. Return to Blockyard, select **Set Bot Token** in the Discord block category, and paste the token.

Discord only shows the token when it is created or reset. Resetting it immediately invalidates the previous token, so remember to update Blockyard afterward.

## 3. Enable Message Content Intent

This is required only for the **when Discord receives a message** block. Sending messages and reading channel history use Discord's HTTP API and do not need this intent.

1. On the same **Bot** page, scroll to **Privileged Gateway Intents**.
2. Enable **Message Content Intent**.
3. Select **Save Changes** if Discord displays the button.

Without this intent, Discord may deliver message events without their text content. Verified apps may also need Discord's approval before they can use a privileged intent.

## 4. Install the bot in a server

1. Open **Installation** in the application sidebar.
2. Under **Installation Contexts**, make sure **Guild Install** is enabled.
3. Under **Default Install Settings**, add the `bot` scope for Guild Install.
4. Grant only the permissions your workflow needs:
   - **View Channels** to list and access channels.
   - **Send Messages** to use the send-message block.
   - **Read Message History** to read earlier messages.
5. Copy the install link, open it, and add the bot to your server.

You need permission to install apps in the target Discord server. Channel-specific permission overrides can still prevent the bot from seeing or posting in an individual channel.

## 5. Check the connection in Blockyard

1. Open the Discord category in the block toolbox.
2. Select a server and channel from the dropdowns.
3. Run a simple **send message** block.

If a server or channel is missing, confirm that the bot is installed in that server and has access to that channel. If Blockyard reports that the token is invalid, reset the token in Discord and replace the saved value in Blockyard.

## What Blockyard stores

Blockyard stores the token in your operating system's secure credential store. It is not saved in the project file. Anyone who opens the project on another computer must configure their own token.

## Related Discord documentation

- [Building your first Discord bot](https://docs.discord.com/developers/quick-start/getting-started)
- [Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents)
- [OAuth2 scopes and bot permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
