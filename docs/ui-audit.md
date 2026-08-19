# Slide editor UI status

Status: the experimental UI rework was reverted on 18 August 2026.

The editor again uses the layout and styling from commit `7b8cacf`:

- New, Open, and Import Keynote are direct controls at the top left.
- Text and Shape remain separate controls in the center.
- Agent, Collaborate, and Present remain direct controls at the right.
- Props, Theme, Build, and History are the sidebar tabs.
- Layout and Magic Move are back in Props.
- The slide rail again shows Slide, Duplicate, Hide, and Delete directly.

The one requested exception is **Export…** beside Import Keynote. Its menu has
only **PDF…** and **Web…**.

![Restored classic editor layout](assets/ui-audit/restored-classic-layout.png)

The screenshot uses the collaboration renderer, which shares the editor canvas,
rail, inspector, toolbar geometry, and original stylesheet. The desktop toolbar
also includes Agent and Collaborate, plus the requested Export menu.

The earlier experimental screenshots remain in `docs/assets/ui-audit/` only as
historical comparison artifacts. They do not describe the current interface.
