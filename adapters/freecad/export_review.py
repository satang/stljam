"""Run inside FreeCAD to export a named set of CAD bodies to StlJam."""
import json
import os
from pathlib import Path

import FreeCAD as App
import Import
import MeshPart


source = Path(os.environ["STLJAM_CAD_INPUT"]).resolve()
destination = Path(os.environ["STLJAM_CAD_OUTPUT"]).resolve()
destination.mkdir(parents=True, exist_ok=True)
names = [name.strip() for name in os.environ.get("STLJAM_CAD_OBJECTS", "").split(",") if name.strip()]
linear_deflection = float(os.environ.get("STLJAM_CAD_DEFLECTION_MM", "0.05"))
if not 0 < linear_deflection <= 10:
    raise ValueError("CAD deflection must be positive and at most 10 mm.")

if source.suffix.lower() == ".fcstd":
    document = App.openDocument(str(source))
elif source.suffix.lower() in {".step", ".stp"}:
    document = App.newDocument("StlJamImport")
    Import.insert(str(source), document.Name)
else:
    raise ValueError("Expected .FCStd, .step or .stp.")
document.recompute()

if names:
    objects = [document.getObject(name) for name in names]
    if any(obj is None for obj in objects):
        raise ValueError("Use the internal FreeCAD object names, e.g. Body, Body001.")
else:
    objects = [
        obj for obj in document.Objects
        if hasattr(obj, "Shape") and not obj.Shape.isNull()
        and (obj.TypeId == "PartDesign::Body" or obj.TypeId.startswith("Part::"))
        and not any(parent.TypeId == "PartDesign::Body" for parent in obj.InList)
    ]

parts = []
for obj in objects:
    if not hasattr(obj, "Shape") or obj.Shape.isNull():
        raise ValueError(f"{obj.Name} has no exportable shape.")
    shape = obj.Shape.copy()
    placement = obj.Placement
    global_placement = obj.getGlobalPlacement()
    shape.Placement = global_placement.multiply(placement.inverse()).multiply(shape.Placement)
    mesh = MeshPart.meshFromShape(
        Shape=shape, LinearDeflection=linear_deflection, AngularDeflection=0.15, Relative=False
    )
    file = f"{obj.Name}.stl"
    mesh.write(str(destination / file))
    parts.append({
        "id": obj.Name, "label": obj.Label, "file": file, "units": "mm",
        "upAxis": "Z", "source": f"{source}#{obj.Name}"
    })
if not parts:
    raise ValueError("No CAD bodies found. Specify STLJAM_CAD_OBJECTS.")
(destination / "manifest.json").write_text(json.dumps({"parts": parts}, indent=2), encoding="utf-8")
print(destination / "manifest.json")
