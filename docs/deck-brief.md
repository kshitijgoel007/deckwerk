# Working on this deck

This folder is a DeckWerk presentation. You make a slide by writing an
ordinary HTML page and importing it; DeckWerk turns what the browser draws
into editable slide objects. Don't read or edit `deck.json`.

## CLI
{{LAUNCHER_HINT}}
## 1. Look at the slides around yours

    slide-agent render . --slide 8,9,10 --output /tmp/ctx     # PNGs
    slide-agent inspect . --html-body --slide 8,9,10          # their markup

Slides are numbered as in the editor's rail. Match the neighbours' fonts,
colours, margins and title position; `theme.css` holds the deck's styles.
`slide-agent comments . --unresolved` shows requests people left on slides.

## 2. Write your slide as a normal web page

Create `drafts/slide.html` — not in `edit/`, which the editor watches:

    <!doctype html>
    <html><head>
    <base href="../">
    <link rel="stylesheet" href="theme.css">
    <style> /* your CSS */ </style>
    </head><body>
    <section class="slide" style="width:1920px;height:1080px;position:relative;overflow:hidden">
      ...
    </section>
    </body></html>

Use any HTML and CSS: flex/grid, `<img>`, `object-fit`, `border-radius`,
`clip-path`, gradients, SVG. Put images in `assets/` (or run
`slide-agent asset import . <file>`) and refer to them as `assets/<name>`.
Iterate in a browser, e.g. `chromium --headless --screenshot=/tmp/s.png
--window-size=1920,1080 drafts/slide.html`. Nothing here involves DeckWerk.

## 3. Put it in the deck

    slide-agent apply . --html drafts/slide.html --after 8    # insert after slide 8
    slide-agent apply . --html drafts/slide.html              # append

The first apply stamps `data-slide-id` into your file; applying it again
replaces that slide, so start each *new* slide from a fresh file. To **replace an existing slide** with your page, copy
its id (from `inspect --html-body`) onto your `<section>` before applying.
To delete or reorder slides, `slide-agent inspect . --html --slide 8,9 >
edit/work.html`, then remove or reorder the `<section>`s there and save.

Check `changes` in apply's output: a `deleted` entry you did not intend
means stop and undo in the editor.

## 4. Check and iterate

    slide-agent render . --slide 9 --output /tmp/final

Compare that with your browser screenshot. If something is off, fix your HTML
and apply again. If DeckWerk draws valid HTML/CSS differently from the
browser, that is a DeckWerk bug: say so rather than working around it.

## About this file

DeckWerk regenerates this `AGENTS.md` when the deck opens. Delete the
generated marker on its first line to keep a custom copy. Longer references,
if you ever need them: `slide-agent docs`.
