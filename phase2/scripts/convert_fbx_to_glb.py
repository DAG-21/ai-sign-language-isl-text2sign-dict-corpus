"""Convert a Mixamo character FBX to a GLB for the avatar, using Blender in the background.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --python scripts/convert_fbx_to_glb.py -- Remy.fbx public/models/Remy.glb [max_texture_px]

Keeps the skeleton (Mixamo bone names, T-pose), the skinned mesh and the textures (capped at max_texture_px, default 1024, stored as JPEG); drops animations. The glTF exporter writes Y-axis bones, the same
convention as public/models/Michelle.glb, which AvatarPlayer already converts rotations for.
"""
import sys

import bpy

args = sys.argv[sys.argv.index("--") + 1 :]
src, dst = args[:2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

arm = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
print("ARMATURES", [(a.name, len(a.data.bones)) for a in arm])
print("MESHES", [(m.name, len(m.data.vertices), [s.material.name if s.material else None for s in m.material_slots]) for m in meshes])
imgs = [(i.name, i.size[0], i.size[1], i.packed_file is not None) for i in bpy.data.images]
print("IMAGES", imgs)
print("ANIMATIONS", [a.name for a in bpy.data.actions])
if arm:
    print("BONES", [b.name for b in arm[0].data.bones][:8], "...", len(arm[0].data.bones))

# Mixamo ships 2048 px textures. They are stored as JPEG (the glTF exporter embeds what it finds); pass a smaller cap (e.g. 1024) for a lighter file.
MAX_TEXTURE = int(args[2]) if len(args) > 2 else 1024
for img in bpy.data.images:
    if img.size[0] > MAX_TEXTURE or img.size[1] > MAX_TEXTURE:
        k = MAX_TEXTURE / max(img.size[0], img.size[1])
        img.scale(max(1, int(img.size[0] * k)), max(1, int(img.size[1] * k)))

# Drop animation data: the avatar is posed at runtime.
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_animations=False, export_skins=True, export_yup=True, export_image_format="JPEG", export_jpeg_quality=90)
print("WROTE", dst)
