/// <reference lib='webworker' />

import type { IslMsg } from './types';

function separateIslands({ positions, normals }: IslMsg) {
  const numFaces = positions.length / 9;
  const faceVisited = new Uint8Array(numFaces);
  const islands: { position: Float32Array; normal: Float32Array }[] = [];

  const vertexToFaces = new Map<string, number[]>();
  const precision = 10000; 

  for (let i = 0; i < numFaces; i++) {
    for (let v = 0; v < 3; v++) {
      const x = Math.round(positions[i * 9 + v * 3] * precision);
      const y = Math.round(positions[i * 9 + v * 3 + 1] * precision);
      const z = Math.round(positions[i * 9 + v * 3 + 2] * precision);
      const key = `${x},${y},${z}`;
      if (!vertexToFaces.has(key)) vertexToFaces.set(key, []);
      vertexToFaces.get(key)!.push(i);
    }
  }

  for (let i = 0; i < numFaces; i++) {
    if (faceVisited[i]) continue;

    const currentIslandFaces: number[] = [];
    const queue = [i];
    faceVisited[i] = 1;

    while (queue.length > 0) {
      const faceIdx = queue.shift()!;
      currentIslandFaces.push(faceIdx);

      for (let v = 0; v < 3; v++) {
        const x = Math.round(positions[faceIdx * 9 + v * 3] * precision);
        const y = Math.round(positions[faceIdx * 9 + v * 3 + 1] * precision);
        const z = Math.round(positions[faceIdx * 9 + v * 3 + 2] * precision);
        const key = `${x},${y},${z}`;
        const neighborFaces = vertexToFaces.get(key) || [];
        for (const nFace of neighborFaces) {
          if (!faceVisited[nFace]) {
            faceVisited[nFace] = 1;
            queue.push(nFace);
          }
        }
      }
    }

    const pos = new Float32Array(currentIslandFaces.length * 9);
    const norm = new Float32Array(currentIslandFaces.length * 9);
    for (let j = 0; j < currentIslandFaces.length; j++) {
      const fIdx = currentIslandFaces[j];
      pos.set(positions.subarray(fIdx * 9, fIdx * 9 + 9), j * 9);
      norm.set(normals.subarray(fIdx * 9, fIdx * 9 + 9), j * 9);
    }
    islands.push({ position: pos, normal: norm });
  }
  return islands;
}

self.onmessage = (e: MessageEvent<IslMsg>) => {
  const result = separateIslands(e.data);
  const transfer = result.flatMap(isl => [isl.position.buffer, isl.normal.buffer]);
  self.postMessage({ success: true, result }, transfer);
};