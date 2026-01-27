import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { saveAs } from 'file-saver';
import * as THREE from 'three';

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const exporter = new GLTFExporter()

export function exportGroupToGLB(group: THREE.Group) {
  group.updateWorldMatrix(true, true)

  exporter.parse(
    group,
    (result) => {
      const blob = new Blob([result as ArrayBuffer], {
        type: 'model/gltf-binary',
      });
      download(blob, 'model.glb');
      console.log(blob)
    },
    (error) => {
      console.error(error);
    },
    {
      binary: true,
      // 必要なら
      // onlyVisible: true,
      // trs: false,
    }
  )
}