"""Convert an fp16 ONNX model to fp32 without touching its graph.

Used by prepare-assets.mjs for BiRefNet: in fp16 its activations overflow on some GPUs (seen on an
NVIDIA RTX 40 series card) and the whole output becomes NaN, i.e. an empty mask.

    python scripts/fp16_to_fp32.py in_fp16.onnx out.onnx      (needs: pip install onnx numpy)
"""
import sys

import numpy as np
import onnx
from onnx import AttributeProto, TensorProto, numpy_helper

F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT


def fix_tensor(t: TensorProto) -> None:
    if t.data_type == F16:
        t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32), t.name))


def fix_graph(g: onnx.GraphProto) -> None:
    for t in g.initializer:
        fix_tensor(t)
    for vi in [*g.input, *g.output, *g.value_info]:
        if vi.type.HasField("tensor_type") and vi.type.tensor_type.elem_type == F16:
            vi.type.tensor_type.elem_type = F32
    for n in g.node:
        for a in n.attribute:
            # Cast(to=fp16) and similar dtype attributes; the Casts become no-ops that ORT removes.
            if a.name in ("to", "dtype") and a.type == AttributeProto.INT and a.i == F16:
                a.i = F32
            elif a.type == AttributeProto.TENSOR:
                fix_tensor(a.t)
            elif a.type == AttributeProto.GRAPH:
                fix_graph(a.g)
            for sub in a.graphs:
                fix_graph(sub)


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    model = onnx.load(src)
    fix_graph(model.graph)
    onnx.checker.check_model(model)
    onnx.save(model, dst)


if __name__ == "__main__":
    main()
