# LUT Tools for Safelight

A [Safelight](https://github.com/anthonyreimche/SafeLight) extension for
look-up tables: put a `.cube` LUT or a HaldCLUT film simulation on a photo,
keep your LUTs in one library across every project, and save a photo's look
as a LUT of its own.

## The LUT panel

The **LUT** panel sits in Develop.

- **Library.** *Add files…* takes `.cube` files and HaldCLUT images (PNG,
  TIFF or JPEG). *Add folder…* takes every LUT in a folder and its
  subfolders, grouped under the folder's name. Search by name or folder,
  right-click a LUT to rename it, and use ✕ (or right-click) to remove it.
  Right-click a folder's heading to remove the whole folder. The library is
  kept between sessions and shared by every project and window.
- **Pick a LUT** by clicking it. Hover over a LUT to see it on the photo
  before you pick it.
- **Strength** blends the LUT with the photo, from 0 to 100%.
- **Input** and **Output** are the encodings the LUT expects and produces:
  sRGB (the default, and what most looks and film simulations expect),
  Rec.709 (gamma 2.4), Gamma 2.2 or Linear. The choice is remembered for each
  LUT the next time you use it.
- **Remove** takes the LUT off the photo.

The LUT is part of the photo's edit, so undo, copy and paste, presets,
syncing between windows, thumbnails and export all carry it. It is drawn
after Safelight's display tools (Tone Curve, HSL, Colour Grading and the
rest), where a look belongs, and before Vignette and Grain.

### When a LUT leaves the library

The edit keeps a small reference to the LUT (an identifier made from the
file's contents, its layout and its name), not the table itself, which would
add hundreds of kilobytes to every edit, every undo step and every copy. If
you remove a LUT from the library, the photos that use it are drawn without
it and the panel says which LUT is missing. Add the same file again and they
pick it up by themselves, wherever you add it from.

## What it reads

- **`.cube`**: 3D tables of 2 to 256 points a side, 1D tables of up to 65,536
  entries, a 1D shaper in front of a 3D table, `TITLE`, `DOMAIN_MIN` /
  `DOMAIN_MAX`, `LUT_1D_INPUT_RANGE` / `LUT_3D_INPUT_RANGE` and comments. Red
  runs fastest, as the format specifies; a file written blue-fastest is
  recognized and read the right way round.
- **HaldCLUT** images of levels 2 to 16, 8 or 16 bits (TIFF also 32-bit
  float), read byte for byte without colour management.
- Tables bigger than 65 points a side are resampled to 65 when added.
- A file that doesn't follow its format is refused, with the reason: a wrong
  entry count, a bad number on a given line, an image that isn't a HaldCLUT.

Colours outside a LUT's input range, such as highlights above white, are
looked up at the edge of the range and the light beyond it is added back, so
highlight detail isn't clipped away. Lookups are tetrahedral, with 16 bits
for every table value.

## Exporting a look

**Export** saves the open photo's colour and tone as a `.cube` (17, 33 or 65
points) or a level 8 HaldCLUT PNG, sRGB in and out. Applied to the same photo
without its edit, the LUT gives back the edited colours.

A LUT can only hold what happens to a colour wherever it is in the picture,
so these are left out, and the panel lists the ones your edit uses:
sharpening, noise reduction, texture, clarity, dehaze, Highlights and
Shadows (which work on each area of the photo), masks, healing, vignette,
grain, crop and geometry, and any extension's effect that looks at
neighbouring pixels.

## Limits

The library holds up to 256 MB of tables, in four parts of 64 MB, and each
LUT goes in the part its file's contents pick. That is room for about 870
LUTs of 33 points or 100 of 65 points before one part fills. The panel shows
how full the library is, and when a part is full, a file that belongs there
is refused with what to do: remove LUTs you no longer use, then add it again.

The library takes only as much memory as its LUTs, and a part goes to the
graphics card the first time a photo needs a LUT from it. Adding a folder of
LUTs reads the files in the background, so Safelight stays responsive while
it works.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
