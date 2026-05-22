# Gmail Troubleshooting

## Gmail API Calls Fail

Verify the Google Workspace setup first. The Gmail agent uses the same
credential audience as the Google Workspace skill.

## Agent Does Not Respond

The Gmail worker uses strict mentions. In chat, mention `@gmail` explicitly or
use the action bar/custom message controls.

## Pills Do Not Render

Renderer sources under `workspace/skills/gmail/renderers/` must be committed
and available to the channel build loader. Re-register the message type after
editing renderer files.

## Unread Counts Look Stale

Run Check now from the action bar. The sync path must process
`messageAdded`, `messageDeleted`, `labelAdded`, and `labelRemoved` history
types.
