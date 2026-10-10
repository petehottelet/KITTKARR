# Revision 1. Guard against replacing complete styles with palette-only recipes.
import json
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from yautja.looks import COMPLETE_PRESETS
from yautja.render import Renderer
from yautja.semantic import Subject

ROOT = Path(__file__).resolve().parent.parent
PRESETS = json.loads((ROOT / 'assistant/yautja-presets-v1.json').read_text())['presets']


class FullStyles(unittest.TestCase):
    def test_every_complete_style_is_selectable_without_palette_substitution(self):
        self.assertEqual({p['id'] for p in PRESETS}, COMPLETE_PRESETS)
        self.assertEqual(len(PRESETS), len(COMPLETE_PRESETS))
        for preset in PRESETS:
            if preset['id'] != 'yautja':
                self.assertEqual(preset['options'], {'look_preset': preset['id']})
        default = PRESETS[0]
        self.assertEqual(default['id'], 'yautja')
        self.assertEqual(default['options']['thermal'], 'low-detail')

    def test_all_styles_render_and_animate_with_live_subject_inputs(self):
        # Deterministic test pixels and mask; never save camera or test imagery.
        x, y = np.meshgrid(np.arange(320), np.arange(192))
        source = Image.fromarray(np.stack([x % 256, y % 256, (x+y) % 256], axis=2).astype('uint8'))
        mask = np.zeros((192, 320), dtype=np.float32)
        mask[20:180, 120:220] = 1
        subject = Subject(mask=mask, label='person', score=1, track_id=1)
        for preset in PRESETS:
            with self.subTest(style=preset['id']):
                renderer = Renderer(320, 192, **preset['options'])
                first = renderer.render(source, .1, subjects=[subject])
                later = renderer.render(source, 2.4, subjects=[subject])
                self.assertEqual(first.size, (320, 192))
                self.assertEqual(later.mode, 'RGB')
                self.assertNotEqual(first.tobytes(), later.tobytes())


if __name__ == '__main__':
    unittest.main()
