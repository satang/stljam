"""Run Blender in background with the source .blend already opened."""
import json
import os
import re
from pathlib import Path

import bpy


destination = Path(os.environ["STLJAM_CAD_OUTPUT"]).resolve()
destination.mkdir(parents=True, exist_ok=True)
names = {name.strip() for name in os.environ.get("STLJAM_CAD_OBJECTS", "").split(",") if name.strip()}
objects = [obj for obj in bpy.context.view_layer.objects if obj.type == "MESH" and (not names or obj.name in names)]
if names and names != {obj.name for obj in objects}:
    raise ValueError("One or more named mesh objects are missing.")

parts = []
used = set()
for index, obj in enumerate(objects):
    identifier = re.sub(r"[^a-zA-Z0-9_-]+", "-", obj.name).lstrip("-_")[:78] or "part"
    if identifier in used:
        identifier += f"-{index + 1}"
    used.add(identifier)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    file = f"{identifier}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(destination / file), export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True, export_animations=False
    )
    scene_scale = bpy.context.scene.unit_settings.scale_length or 1
    parts.append({
        "id": identifier, "label": obj.name, "file": file, "units": "m", "upAxis": "Y",
        "transform": [scene_scale, 0, 0, 0, 0, scene_scale, 0, 0, 0, 0, scene_scale, 0, 0, 0, 0, 1],
        "source": f"{bpy.data.filepath}#{obj.name}"
    })
if not parts:
    raise ValueError("No mesh objects found.")
(destination / "manifest.json").write_text(json.dumps({"parts": parts}, indent=2), encoding="utf-8")
print(destination / "manifest.json")
