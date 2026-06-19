## 2024-10-24 - Numeric Input Types in Obsidian Settings
**Learning:** Obsidian's `Setting` class `addText` method creates a standard `HTMLInputElement` under `text.inputEl`. Even though it's `.addText()`, we can set `text.inputEl.type = "number"` and `text.inputEl.min = "..."` directly on the input element for numeric settings to provide spinner controls on desktop and numpads on mobile.
**Action:** Always check settings tabs for inputs representing milliseconds, counts, or limits, and upgrade them from default text to number types to improve validation and UX.
