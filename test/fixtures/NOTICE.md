# Herkunft der Fixtures

`test.glb`, `inverted.glb`, `textured.glb` — selbst erzeugt.

`meshopt-v0.glb`, `meshopt-v1.glb`, `meshopt-min.glb` — selbst erzeugt mit dem
Encoder aus zeux/meshoptimizer (MIT).

`MeshoptCubeTest.glb` — aus KhronosGroup/glTF-Sample-Assets.

`fbx-7100-plain.fbx`, `fbx-7400-plain.fbx`, `fbx-7400-deflate.fbx`,
`fbx-7500-plain.fbx`, `fbx-7500-deflate.fbx`, `fbx-7400-moved.fbx` — selbst
erzeugt von `test/make-fbx-fixtures.js`. Alle sechs enthalten denselben
Einheitswürfel: 8 Vertices, 6 Vierecke, nach Fächerung 12 Dreiecke. Sie decken
beide Feldbreiten (32 Bit bis 7400, 64 Bit ab 7500), beide Array-Kodierungen
(roh und deflate) und eine `Lcl Translation` ab. Der Generator wird bewusst
nicht bei jedem Testlauf ausgeführt — sonst prüfte er sich selbst.

`box.fbx` — aus assimp (`test/models/FBX/box.fbx`), 3-Klausel-BSD.
Copyright (c) 2006-2024, assimp team. Eine fremde Datei ist hier Absicht: sie
fängt einen gemeinsamen Irrtum von Generator und Leser ab, den zwei selbst
erzeugte Dateien niemals zeigen würden.
