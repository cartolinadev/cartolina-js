// a list of obsolete vts constants, automatically created from the old version of webpack.config.json

export const VTS_TREETRAVERSAL_DRAW = 0;

export const MATERIAL_DEPTH = 1;
export const MATERIAL_FLAT = 2;
export const MATERIAL_FOG = 3;
export const MATERIAL_INTERNAL = 4;
export const MATERIAL_INTERNAL_NOFOG = 5;
export const MATERIAL_EXTERNAL = 6;
export const MATERIAL_EXTERNAL_NOFOG = 7;

export const PIPELINE_BASIC = 0;
export const PIPELINE_HMAP = 1;
export const PIPELINE_PROCEDURAL =2;

export const DRAWCOMMAND_STATE = 1;
export const DRAWCOMMAND_SUBMESH = 2;
export const DRAWCOMMAND_GEODATA = 3;
export const DRAWCOMMAND_APPLY_BUMPS = 4;

export const TEXTURECHECK_MEATATILE = 1;
export const TEXTURECHECK_TYPE = 2;
export const TEXTURECHECK_CODE = 3;
export const TEXTURECHECK_SIZE = 4;

export const TEXTURETYPE_COLOR = 0;
export const TEXTURETYPE_HEIGHT = 1;
export const TEXTURETYPE_CLASS = 2;

export const JOB_FLAT_LINE = 1;
export const JOB_FLAT_RLINE = 2;
export const JOB_FLAT_TLINE = 3;
export const JOB_PIXEL_LINE = 4;
export const JOB_PIXEL_TLINE =5;
export const JOB_LINE_LABEL = 6;
export const JOB_ICON = 7;
export const JOB_LABEL = 8;
export const JOB_PACK = 9;
export const JOB_VSPOINT = 10;
export const JOB_POLYGON = 11;
export const JOB_MESH = 12;
export const JOB_POINTCLOUD = 13;

export const TILE_COUNT_FACTOR = 0.5;

export const NO_OVERLAP_DIRECT = 0;
export const NO_OVERLAP_DIV_BY_DIST = 1;

export const WORKERCOMMAND_ADD_RENDER_JOB =5;
export const WORKERCOMMAND_STYLE_DONE = 6;
export const WORKERCOMMAND_ALL_PROCESSED = 7;
export const WORKERCOMMAND_READY = 8;
export const WORKERCOMMAND_GROUP_BEGIN = 9;
export const WORKERCOMMAND_GROUP_END = 10;
export const WORKERCOMMAND_LOAD_FONTS =11;
export const WORKERCOMMAND_LOAD_BITMPAS = 12;

export const WORKER_TYPE_LABEL = 1;
export const WORKER_TYPE_LABEL2 = 2;
export const WORKER_TYPE_ICON =3;
export const WORKER_TYPE_ICON2 = 4;
export const WORKER_TYPE_POINT_GEOMETRY = 5;
export const WORKER_TYPE_FLAT_LINE = 6;
export const WORKER_TYPE_FLAT_RLINE = 7;
export const WORKER_TYPE_FLAT_TLINE = 8;
export const WORKER_TYPE_PIXEL_LINE = 9;
export const WORKER_TYPE_PIXEL_TLINE = 10;
export const WORKER_TYPE_LINE_LABEL = 11;
export const WORKER_TYPE_LINE_LABEL2 = 12;
export const WORKER_TYPE_POLYGON = 13;
export const WORKER_TYPE_LINE_GEOMETRY = 14;

export const WORKER_TYPE_PACK_BEGIN = 15;
export const WORKER_TYPE_PACK_END = 16;

export const WORKER_TYPE_VSWITCH_BEGIN = 17;
export const WORKER_TYPE_VSWITCH_STORE = 18;
export const WORKER_TYPE_VSWITCH_END = 19;
export const WORKER_TYPE_VSPOINT = 20;

export const WORKER_TYPE_NODE_BEGIN = 21;
export const WORKER_TYPE_NODE_END = 22;
export const WORKER_TYPE_MESH = 23;
export const WORKER_TYPE_LOAD_NODE = 24;

export const TILE_SHADER_CLIP4 = (1<<0);
export const TILE_SHADER_CLIP8 = (1<<1);
export const TILE_SHADER_SE = (1<<2);
export const TILE_SHADER_BLEND_MULTIPLY = 	  (1<<3);
export const TILE_SHADER_ILLUMINATION = 	  (1<<4);
export const TILE_SHADER_WHITEWASH = (1<<5);

export const IMPORATANCE_LOG_BASE = 1.0017;
export const IMPORATANCE_INV_LOG = 1355.6127860321758038669705901537; // 1/log(LOG_BASE)
