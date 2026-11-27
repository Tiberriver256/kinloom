import type { CommandParseSpec, OptionSpec } from '../../runtime/args.js';

export function outAliasOption(): OptionSpec {
  return {
    key: 'outOpt',
    kind: 'string',
    flags: ['--out', '-o', '--output'],
    metavar: 'PATH',
    help: 'Alias for the positional output path.',
  };
}

export function outDirOption(help: string): OptionSpec {
  return {
    key: 'outDir',
    kind: 'string',
    flags: ['--out-dir', '--out', '-o', '--output-dir', '--output'],
    required: true,
    metavar: 'DIR',
    help,
  };
}

export function maxWidthOption(defaultVal: number | undefined, help: string): OptionSpec {
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

export function maxKbOption(defaultVal: number | undefined, help: string): OptionSpec {
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

export function qualityOption(defaultVal: number, help: string): OptionSpec {
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

export function rotateOption(help: string): OptionSpec {
  return {
    key: 'rotate',
    kind: 'number',
    flags: ['--rotate'],
    metavar: 'DEG',
    help,
  };
}

export function previewOutOption(help: string): OptionSpec {
  return {
    key: 'previewOut',
    kind: 'string',
    flags: ['--preview-out'],
    metavar: 'PATH',
    help,
  };
}

export function jsonOption(alwaysEnabled = false): OptionSpec {
  return {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: alwaysEnabled ? 'Emit JSON output (always enabled).' : 'Emit JSON output.',
  };
}

export function directionOption(): OptionSpec {
  return {
    key: 'direction',
    kind: 'string',
    flags: ['--direction'],
    default: 'vertical',
    metavar: 'DIR',
    help: 'Stack direction: vertical or horizontal (aliases v, h). Default: vertical.',
  };
}

export function dividerColorOption(help: string): OptionSpec {
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

export const INFO_OPTIONS: readonly OptionSpec[] = [jsonOption()];

export const INFO_PARSE_SPEC: CommandParseSpec = {
  options: INFO_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  positionalLabel: 'image path',
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
