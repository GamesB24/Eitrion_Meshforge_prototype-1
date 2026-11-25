// Plain rules shared by Play and the tests. Original MIT code.
// Nothing in here is a function that would be posted to a Worker.

export const DEFAULT_CAMERA_FAR = 2000;

export function cameraFarForSpan(span) {
  const size = Math.abs(+span) || 0;
  return Math.max(DEFAULT_CAMERA_FAR, size * 4);
}

export function landscapeSendScale(meshEdge, opts = {}) {
  const edge = Math.max(Math.abs(+meshEdge) || 0, 1e-6);
  if (opts.scale != null && Number.isFinite(+opts.scale)) return +opts.scale;
  if (opts.size != null && Number.isFinite(+opts.size)) return +opts.size / edge;
  return 1;
}

export function isOverlapTarget(info = {}) {
  if (!info || info.isScene) return false;
  if (info.type === 'level') return false;
  const name = String(info.name || '').toLowerCase();
  if (name === 'terrain' || name === 'water') return false;
  return true;
}

export function plainActorRef(obj = {}) {
  const tags = Array.isArray(obj.tags) ? obj.tags.map((tag) => String(tag)) : [];
  const position = Array.isArray(obj.position) ? obj.position.slice(0, 3).map((n) => +n || 0) : [0, 0, 0];
  return {
    id: obj.id == null ? null : String(obj.id),
    name: String(obj.name || ''),
    type: String(obj.type || 'static'),
    tags,
    position,
  };
}

export function actorRefHasTag(ref, tag) {
  return Array.isArray(ref?.tags) && ref.tags.includes(tag);
}
