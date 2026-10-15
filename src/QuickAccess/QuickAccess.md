---
name: Library/ppenguin/QuickAccess
tags: meta/library
author: ppenguin
description: A touch-friendly quick actions button for common SilverBullet commands
---

# QuickAccess

Adds a **QuickAccess** button to the top bar. Tap it to choose one of these
commands:

- **New quick note** — runs `Quick Note`.
- **New handwritten** — runs `SilverInk: New handwritten` (requires SilverInk).
- **Edit handwritten** — runs `SilverInk: Edit handwritten` (requires SilverInk).
- **Delete handwritten block** — runs `SilverInk: Delete selected block` (requires SilverInk).
- **Reload plugs** — runs `Plugs: Reload`.
- **Reload system** — runs `System: Reload`.

The button stays visible on narrow screens. The picker has no text input, so
opening it does not summon the on-screen keyboard. To change the shortcuts,
edit the `actions` table below and run **System: Reload**.

```space-lua
local actions = {
  { label = "New quick note", command = "Quick Note", icon = "file-plus" },
  { label = "New handwritten", command = "SilverInk: New handwritten", icon = "pen-tool" },
  { label = "Edit handwritten", command = "SilverInk: Edit handwritten", icon = "edit-3" },
  { label = "Delete handwritten block", command = "SilverInk: Delete selected block", icon = "trash-2" },
  { label = "Reload plugs", command = "Plugs: Reload", icon = "refresh-cw" },
  { label = "Reload system", command = "System: Reload", icon = "refresh-ccw" },
}

command.define {
  name = "QuickAccess: Open",
  run = function()
    local selected = view.pick {
      title = "QuickAccess",
      source = function() return actions end,
      filter = false,
      presentation = {
        mode = "list",
        row = {
          primary = "label",
          icon = function(item) return item.icon end,
          cssClass = function() return "quickaccess-action" end,
        },
      },
    }
    if selected then editor.invokeCommand(selected.command) end
  end,
}

actionButton.define {
  icon = "grid",
  description = "QuickAccess",
  command = "QuickAccess: Open",
  priority = 2.5,
  dropdown = false,
}
```

```space-style
.quickaccess-action {
  min-height: 3.5rem;
  padding-block: 0.75rem;
  font-size: 1rem;
  touch-action: manipulation;
}
```
