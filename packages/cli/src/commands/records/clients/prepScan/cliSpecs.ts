import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DEFAULT_TIMEOUT_S } from './geometry.js';

function outAliasOption(): OptionSpec {
  return {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  };
}

function outDirOption(help: string): OptionSpec {
  return {
    key: 'outDir',
    kind: 'string',
    flags: ['--out-dir', '--out', '-o', '--output-dir', '--output'],
    required: true,
    metavar: 'DIR',
    help,
  };
}

function maxWidthOption(defaultVal: number | undefined, help: string): OptionSpec {
  return {
    key: 'maxWidth',
    kind: 'integer',
    flags: ['--max-width'],
    ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    min: 1,
    metavar: 'PX',
    help,
  };
}

function maxKbOption(defaultVal: number | undefined, help: string): OptionSpec {
  return {
    key: 'maxKb',
    kind: 'integer',
    flags: ['--max-kb'],
    ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    min: 1,
    metavar: 'KB',
    help,
  };
}

function qualityOption(defaultVal: number, help: string): OptionSpec {
  return {
    key: 'quality',
    kind: 'integer',
    flags: ['--quality'],
    default: defaultVal,
    min: 1,
    max: 100,
    metavar: 'N',
    help,
  };
}

function rotateOption(help: string): OptionSpec {
  return {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help,
  };
}

function previewOutOption(help: string): OptionSpec {
  return {
    key: 'previewOut',
    kind: 'string',
    flags: ['--preview-out'],
    metavar: 'PATH',
    help,
  };
}

function jsonOption(alwaysEnabled = false): OptionSpec {
  return {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: alwaysEnabled ? 'Emit JSON output (always enabled).' : 'Emit JSON output.',
  };
}

function directionOption(): OptionSpec {
  return {
    key: 'direction',
    kind: 'string',
    flags: ['--direction'],
    default: 'vertical',
    metavar: 'DIR',
    help: 'Stack direction: vertical or horizontal (aliases v, h). Default: vertical.',
  };
}

function dividerColorOption(help: string): OptionSpec {
  return {
    key: 'dividerColor',
    kind: 'string',
    flags: ['--divider-color'],
    default: '#222222',
    metavar: 'COLOR',
    help,
  };
}

export const PREVIEW_OPTIONS: readonly OptionSpec[] = [
  outDirOption('Output directory for preview JPEGs (--out/-o/--output-dir are aliases).'),
  maxWidthOption(1400, 'Maximum pixel width (default: 1400).'),
  maxKbOption(280, 'Maximum file size in KB (default: 280).'),
  rotateOption('Optional clockwise rotation in degrees applied before previewing.'),
  {
    key: 'deskew',
    kind: 'boolean',
    flags: ['--deskew'],
    help: 'Attempt automatic small-angle deskewing before saving.',
  },
  jsonOption(),
];

export const PREVIEW_PARSE_SPEC: CommandParseSpec = {
  options: PREVIEW_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image path',
};

export const CROP_OPTIONS: readonly OptionSpec[] = [
  outAliasOption(),
  qualityOption(92, 'Archival output JPEG/WEBP quality 1..100 (default: 92).'),
  {
    key: 'box',
    kind: 'string',
    flags: ['--box'],
    metavar: 'BOX',
    help: 'Crop box x0,y0,x1,y1 on the rotated image. Omit --box to keep the full rotated frame.',
  },
  rotateOption(
    'Optional clockwise rotation applied before cropping (e.g. 90, 180, 270, or arbitrary degrees).'
  ),
  {
    key: 'redact',
    kind: 'string',
    flags: ['--redact'],
    multiple: true,
    metavar: 'BOX',
    help: 'One or more x0,y0,x1,y1 black redaction boxes in cropped-image coordinates.',
  },
  {
    key: 'redactOrig',
    kind: 'string',
    flags: ['--redact-orig'],
    multiple: true,
    metavar: 'BOX',
    help: 'One or more x0,y0,x1,y1 black boxes in rotated-image coordinates (same coordinates as prep-scan grid). Drawn before the crop.',
  },
  previewOutOption(
    'Optional explicit path for the < 280 KB verification preview (defaults to cache previews dir).'
  ),
  maxWidthOption(1400, 'Preview maximum pixel width (default: 1400).'),
  maxKbOption(280, 'Preview maximum size in KB (default: 280).'),
  jsonOption(),
];

export const CROP_PARSE_SPEC: CommandParseSpec = {
  options: CROP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

export const SHEET_STRIP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    required: true,
    metavar: 'PATH',
    help: 'Output JPEG path for the stitched contact sheet.',
  },
  {
    key: 'band',
    kind: 'string',
    flags: ['--band'],
    default: 'top',
    choices: ['top', 'left'],
    help: 'Band edge to slice (default: top).',
  },
  {
    key: 'bandPct',
    kind: 'number',
    flags: ['--band-pct'],
    default: 18.0,
    metavar: 'PCT',
    help: 'Percent of image height/width to slice (default: 18).',
  },
  maxKbOption(250, 'Maximum output file size in KB (default: 250).'),
  {
    key: 'width',
    kind: 'integer',
    flags: ['--width'],
    default: 1400,
    min: 1,
    metavar: 'PX',
    help: 'Normalized strip width in pixels (default: 1400).',
  },
  {
    key: 'timeout',
    kind: 'number',
    flags: ['--timeout'],
    default: DEFAULT_TIMEOUT_S,
    metavar: 'SEC',
    help: 'Per-URL HTTP timeout seconds (default: 12).',
  },
  {
    key: 'noRotateLeft',
    kind: 'boolean',
    flags: ['--no-rotate-left'],
    help: 'Keep --band left vertical instead of rotating 90 deg CW for horizontal reading.',
  },
  jsonOption(),
];

export const SHEET_STRIP_PARSE_SPEC: CommandParseSpec = {
  options: SHEET_STRIP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'source URL or path',
};

export const PDF_PAGES_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'pages',
    kind: 'string',
    flags: ['--pages', '--page', '-p'],
    required: true,
    metavar: 'SPEC',
    help: '1-based page numbers and inclusive ranges, e.g. 1,3,10-12 (max 25 per call).',
  },
  outDirOption('Output directory for rendered pages and previews (--out/-o are aliases).'),
  {
    key: 'dpi',
    kind: 'integer',
    flags: ['--dpi'],
    default: 150,
    min: 1,
    metavar: 'DPI',
    help: 'Rendering DPI for pdftoppm (default: 150).',
  },
  {
    key: 'format',
    kind: 'string',
    flags: ['--format'],
    default: 'jpg',
    metavar: 'FMT',
    help: 'Rendered page image format: jpg or png (default: jpg).',
  },
  maxWidthOption(1400, 'Preview maximum pixel width (default: 1400).'),
  maxKbOption(280, 'Maximum preview/strip size in KB (default: 280).'),
  {
    key: 'strip',
    kind: 'string',
    flags: ['--strip'],
    metavar: 'PATH',
    help: 'Optional output JPEG path for a labeled contact strip.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Ignore cached rendered pages and re-render via pdftoppm.',
  },
  jsonOption(),
];

export const PDF_PAGES_PARSE_SPEC: CommandParseSpec = {
  options: PDF_PAGES_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'PDF path',
};

export const PDF_GREP_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'pattern',
    kind: 'string',
    flags: ['--pattern', '-e'],
    required: true,
    metavar: 'REGEX',
    help: 'Regular expression, matched within each text line.',
  },
  {
    key: 'ignoreCase',
    kind: 'boolean',
    flags: ['-i', '--ignore-case'],
    help: 'Case-insensitive match.',
  },
  {
    key: 'context',
    kind: 'integer',
    flags: ['--context'],
    default: 200,
    min: 0,
    metavar: 'CHARS',
    help: 'Characters of page text to show on each side of a match (default: 200).',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 25,
    min: 1,
    metavar: 'N',
    help: 'Maximum matches to print (default: 25); all matches still count.',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Ignore cached page text and extract the PDF again.',
  },
  jsonOption(),
];

export const PDF_GREP_PARSE_SPEC: CommandParseSpec = {
  options: PDF_GREP_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'PDF path',
};

export const GRID_OPTIONS: readonly OptionSpec[] = [
  outAliasOption(),
  {
    key: 'step',
    kind: 'integer',
    flags: ['--step'],
    default: 200,
    min: 1,
    metavar: 'PX',
    help: 'Grid line interval in original image pixels (default: 200).',
  },
  maxWidthOption(1600, 'Maximum preview width in pixels (default: 1600).'),
  maxKbOption(280, 'Maximum preview file size in KB (default: 280).'),
  rotateOption('Optional clockwise rotation applied before measuring coordinates.'),
  jsonOption(true),
];

export const GRID_PARSE_SPEC: CommandParseSpec = {
  options: GRID_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

export const STITCH_OPTIONS: readonly OptionSpec[] = [
  outAliasOption(),
  {
    key: 'box',
    kind: 'string',
    flags: ['--box'],
    multiple: true,
    required: true,
    metavar: 'BOX',
    help: 'Crop box x0,y0,x1,y1 in original image coordinates (repeatable; at least 2 required).',
  },
  {
    key: 'redact',
    kind: 'string',
    flags: ['--redact'],
    multiple: true,
    metavar: 'BOX',
    help: 'Optional x0,y0,x1,y1 black redaction boxes in original image coordinates applied before cropping.',
  },
  rotateOption('Optional clockwise rotation applied before redacting and cropping.'),
  directionOption(),
  {
    key: 'gap',
    kind: 'integer',
    flags: ['--gap'],
    default: 6,
    min: 0,
    metavar: 'PX',
    help: 'Divider gap in pixels between stacked bands (default: 6).',
  },
  dividerColorOption('Divider fill color as hex or RGB name (default: "#222222").'),
  {
    key: 'labels',
    kind: 'string',
    flags: ['--labels', '--label'],
    multiple: true,
    metavar: 'TEXT',
    help: 'Optional panel header labels (repeatable or comma-separated).',
  },
  {
    key: 'headerHeight',
    kind: 'integer',
    flags: ['--header-height'],
    min: 0,
    metavar: 'PX',
    help: 'Header bar height in pixels when --labels are provided (default: 26).',
  },
  qualityOption(90, 'Output JPEG/WEBP quality 1..100 (default: 90).'),
  maxWidthOption(undefined, 'Optional maximum width for compact JPEG output.'),
  maxKbOption(undefined, 'Optional maximum size in KB for compact JPEG output.'),
  jsonOption(true),
];

export const STITCH_PARSE_SPEC: CommandParseSpec = {
  options: STITCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

export const INFO_OPTIONS: readonly OptionSpec[] = [jsonOption()];

export const INFO_PARSE_SPEC: CommandParseSpec = {
  options: INFO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image path',
};

export const JOIN_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'out',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    required: true,
    metavar: 'PATH',
    help: 'Archival JPEG or PNG output path.',
  },
  directionOption(),
  {
    key: 'gap',
    kind: 'integer',
    flags: ['--gap'],
    default: 8,
    min: 0,
    metavar: 'PX',
    help: 'Pixels of divider color between images (default: 8).',
  },
  dividerColorOption('Gap and margin fill color as hex or a named RGB color (default: "#222222").'),
  {
    key: 'align',
    kind: 'string',
    flags: ['--align'],
    default: 'center',
    metavar: 'ALIGN',
    help: 'Place a shorter image at start, center, or end of the cross axis (default: center).',
  },
  qualityOption(92, 'Archival JPEG/WEBP quality 1..100 (default: 92). Ignored for PNG.'),
  previewOutOption('Optional compact JPEG preview path (max width 1400, max size 280 KB).'),
  maxWidthOption(1400, 'Preview maximum pixel width when --preview-out is set (default: 1400).'),
  maxKbOption(280, 'Preview maximum size in KB when --preview-out is set (default: 280).'),
  jsonOption(true),
];

export const JOIN_PARSE_SPEC: CommandParseSpec = {
  options: JOIN_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image paths',
};

export const ROTATE_OPTIONS: readonly OptionSpec[] = [
  outAliasOption(),
  {
    key: 'angle',
    kind: 'number',
    flags: ['--angle', '--rotate', '--degrees', '-a'],
    required: true,
    metavar: 'DEG',
    help: 'Clockwise rotation angle in degrees (e.g. 90, 180, 270, or arbitrary degrees).',
  },
  qualityOption(92, 'Archival output JPEG/WEBP quality 1..100 (default: 92).'),
  previewOutOption('Optional compact JPEG preview path.'),
  maxWidthOption(1400, 'Preview maximum pixel width (default: 1400).'),
  maxKbOption(280, 'Preview maximum size in KB (default: 280).'),
  jsonOption(),
];

export const ROTATE_PARSE_SPEC: CommandParseSpec = {
  options: ROTATE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 2,
  positionalLabel: 'input image',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom prep-scan <subcommand> [options]',
    summary:
      'Report image dimensions, join separate page scans, generate compact inspection previews, ' +
      'redacted archival crops, census sheet-strip contact sheets, and selective PDF page renders.',
    subcommands: [
      { name: 'preview', summary: 'Generate compact JPEG inspection previews in parallel.' },
      {
        name: 'crop',
        summary: 'Rotate, optionally crop, draw black redaction boxes, and write a verification preview.',
      },
      {
        name: 'sheet-strip',
        summary: 'Download or read sheet bands in parallel and stitch one labeled contact sheet.',
      },
      {
        name: 'pdf-pages',
        summary: 'Render requested PDF pages in parallel via pdftoppm with disk caching.',
      },
      { name: 'pdf-grep', summary: 'Search PDF text page by page and report 1-based page numbers.' },
      {
        name: 'grid',
        summary: 'Draw an original-pixel coordinate grid overlay onto a compact JPEG preview.',
      },
      { name: 'stitch', summary: 'Crop 2+ boxes from one scan, apply optional redactions, and stack bands.' },
      {
        name: 'info',
        summary: 'Print pixel size, format, mode, and file size for one or more local images.',
      },
      { name: 'join', summary: 'Join 2 or more images into one archival JPEG or PNG, in input order.' },
      { name: 'rotate', summary: 'Rotate a scan clockwise by any angle and save an archival image.' },
    ],
  });
}

export function renderCropHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom prep-scan crop <input> [<output> | --out <output>] [--box BOX] [options]',
    summary:
      'Rotate, optionally crop, draw black redaction boxes, and write a verification preview. ' +
      '--redact-orig uses rotated-image coordinates. --redact uses cropped-image coordinates.',
    options: CROP_OPTIONS,
  });
}

export function renderSubcommandHelp(subcmd: string): string {
  switch (subcmd) {
    case 'preview':
      return formatCommandUsage({
        usage: 'kinloom prep-scan preview <images...> --out-dir <dir> [options]',
        summary: 'Generate compact JPEG inspection previews in parallel.',
        options: PREVIEW_OPTIONS,
      });
    case 'crop':
      return renderCropHelp();
    case 'sheet-strip':
      return formatCommandUsage({
        usage: 'kinloom prep-scan sheet-strip <sources...> --out <file> [options]',
        summary:
          'Download or read census sheet header/street bands in parallel and stitch one labeled contact sheet.',
        options: SHEET_STRIP_OPTIONS,
      });
    case 'pdf-pages':
      return formatCommandUsage({
        usage: 'kinloom prep-scan pdf-pages <pdf_path> --pages <spec> --out-dir <dir> [options]',
        summary:
          'Render requested PDF pages in parallel via pdftoppm with disk caching, compact previews, and optional contact strip.',
        options: PDF_PAGES_OPTIONS,
      });
    case 'pdf-grep':
      return formatCommandUsage({
        usage: 'kinloom prep-scan pdf-grep <pdf_path> --pattern <regex> [options]',
        summary:
          'Search PDF text page by page (pdftotext) and print 1-based page numbers + snippets to feed `pdf-pages --pages`.',
        options: PDF_GREP_OPTIONS,
      });
    case 'grid':
      return formatCommandUsage({
        usage: 'kinloom prep-scan grid <image> [<out> | --out <out>] [options]',
        summary: 'Draw an original-pixel coordinate grid overlay onto a compact JPEG preview.',
        options: GRID_OPTIONS,
      });
    case 'stitch':
      return formatCommandUsage({
        usage:
          'kinloom prep-scan stitch <image> [<out> | --out <out>] --box <x0,y0,x1,y1> --box <x0,y0,x1,y1> [options]',
        summary: 'Crop 2+ boxes from one scan, apply optional redactions, and stack bands.',
        options: STITCH_OPTIONS,
      });
    case 'info':
      return formatCommandUsage({
        usage: 'kinloom prep-scan info <images...> [--json]',
        summary: 'Print pixel size, format, mode, and file size for one or more local images.',
        options: INFO_OPTIONS,
      });
    case 'join':
      return formatCommandUsage({
        usage: 'kinloom prep-scan join <images...> --out <file> [options]',
        summary: 'Join 2 or more images into one archival JPEG or PNG, in input order.',
        options: JOIN_OPTIONS,
      });
    case 'rotate':
      return formatCommandUsage({
        usage: 'kinloom prep-scan rotate <input> [<output> | --out <output>] --angle <deg> [options]',
        summary: 'Rotate an image clockwise by an angle and save an archival output.',
        options: ROTATE_OPTIONS,
      });
    default:
      return renderRootHelp();
  }
}
