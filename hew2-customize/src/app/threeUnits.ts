import * as THREE from 'three';

export function getVec3Like(v: THREE.Vector2Like | THREE.Vector3Like) {
  return { x: v.x, y: v.y, z: ('z' in v ? (v.z ?? 0) : 0) };
}

export function toFloat32Arr(v: THREE.Vector3Like[]) {
  const positions = new Float32Array(v.length * 3);
  v.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
  });
  return positions;
}

export function getMats(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

export function meshMatrixUpdate(mesh: THREE.Mesh) {
  mesh.updateMatrix();
  mesh.updateMatrixWorld();
}

export function meshAttrDispose(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  getMats(mesh).forEach(m => m.dispose());
}