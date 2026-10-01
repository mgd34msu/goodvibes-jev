# Screenshot tour

These screenshots are captured from the end-to-end suite's seeded mock daemon,
dark theme, at desktop and phone sizes. Live auth, chat history, providers, and
daemon state vary by operator environment, so treat these as layout references
rather than fixed data fixtures.

GoodVibes has four places in the sidebar (Chat, Work, Library, Personal), a
settings dialog, and an account menu. Links from earlier versions (`?view=fleet`,
`?view=memory`, `?view=admin` and the rest) redirect to the matching place; see
[operator-guide.md](operator-guide.md#navigation).

## New chat

A new chat opens on a greeting, one composer with the model picker, voice and
attachments, and starting points for the other places. Recent chats are listed
in the sidebar, newest first.

![New chat with a greeting, the composer and suggestion chips](assets/screenshots/new-chat.png)

## A conversation

Replies stream with syntax-highlighted Markdown and per-block copy. Tool
activity folds into a single quiet line ("Read 2 files, searched the web") that
expands on demand.

![A conversation with a collapsed tool-activity line and a highlighted code block](assets/screenshots/conversation.png)

## Work

Work lists everything running for you in one place, with what needs you first.
The segmented control filters to Sessions, Agents or Processes. An item opens in
a detail pane beside the list (an approval here, with its command, risk, a
Remember choice, and Approve and Deny). While the detail is open the sidebar
folds to an icon rail.

![Work with an approval open in the detail pane and the sidebar folded to a rail](assets/screenshots/work-needs-you.png)

## Library

Library holds Memory, Knowledge and Review. Memory shows each record's type,
scope and confidence, and says which search mode actually ran. Knowledge is the
regular Knowledge/Wiki surface; Review is everything waiting on a human call.

![Library on the Memory section with filters and confidence on each record](assets/screenshots/library-memory.png)

## Personal

Personal holds Calendar, Mail and Occasions. A daemon without a calendar or mail
account says so rather than showing an empty page.

![Personal on the Calendar section showing an agenda](assets/screenshots/personal-calendar.png)

## Settings

Settings is a dialog with seven pages (General, Account, Models and providers,
Voice, Notifications, Memory, Permissions) and a search box. Models and
providers shows the current model new chats use and each provider's sign-in
state.

![Settings dialog open on Models and providers](assets/screenshots/settings-models.png)

## Account menu

The account button at the foot of the sidebar opens a menu with Settings,
Devices and pairing, People and channels, Check-ins, the theme switch, the
GoodVibes Neon toggle, your connection to the daemon in plain words, and Sign
out.

![The account menu open over the Work page](assets/screenshots/account-menu.png)

## On a phone

At phone width the sidebar becomes a drawer behind the header's menu button or a
swipe from the left edge. The same four places are in it, with the count of
items that need you beside Work.

<img src="assets/screenshots/phone-conversation.png" alt="Phone layout with a conversation and the composer" width="260">
<img src="assets/screenshots/phone-drawer.png" alt="Phone layout with the navigation drawer open" width="260">

## GoodVibes Neon

GoodVibes Neon is an opt-in theme, turned on under Settings, General or from the
account menu. It never replaces a theme you chose.

![The new-chat screen in the GoodVibes Neon theme](assets/screenshots/theme-neon.png)

## Not shown

Mail, Occasions, the Review list, check-ins, the phone node page and the
pairing hand-off do not have captures here. Their behavior is documented in
[operator-guide.md](operator-guide.md).
