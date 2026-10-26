# Avatar attribution

`ybot.glb` is the "Y Bot" rig from [Adobe Mixamo](https://www.mixamo.com/),
used under the Mixamo license (free for commercial and non-commercial use).

"Default" in the app is this file. "Human" is `Remy.glb`, the Mixamo character
"Remy", downloaded from Adobe Mixamo (FBX, T-pose, no animation) and converted
with `scripts/convert_fbx_to_glb.py` (Blender; textures scaled to 1024 px and
stored as JPEG), used under the Mixamo license. Mixamo does not allow
redistributing its characters as standalone assets: if this repository is
public, keep `Remy.glb` (and `ybot.glb`) out of it and have each developer add
their own copy. Remy has the same Mixamo bone names and T-pose as Y Bot but
different bone axes, so `AvatarPlayer.tsx` converts every rotation through each
bone's rest world rotation. His proportions are close to Y Bot's, so the tracks'
hand and face positions carry over.

The previous "brunette" Ready Player Me avatar (`brunette.glb`, CC BY-NC 4.0)
was removed on 2026-08-28.
