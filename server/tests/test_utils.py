import numpy as np
import utils


def test_gender_from_pitch_thresholds():
    assert utils.gender_from_pitch(None) == "unknown"
    assert utils.gender_from_pitch(120.0) == "male"
    assert utils.gender_from_pitch(200.0) == "female"
    # in-between band is "unknown" per your heuristic
    assert utils.gender_from_pitch(170.0) == "unknown"


def test_speaker_merge_config_resolved_absorb_sim_default():
    cfg = utils.SpeakerMergeConfig(merge_sim=0.74, absorb_sim=None)
    assert cfg.resolved_absorb_sim() == 0.74 - 0.20


def test_speaker_merge_config_resolved_absorb_sim_explicit():
    cfg = utils.SpeakerMergeConfig(merge_sim=0.74, absorb_sim=0.6)
    assert cfg.resolved_absorb_sim() == 0.6


def test_estimate_pitch_yin_silence_does_not_crash():
    sr = 16000
    y = np.zeros(sr, dtype=np.float32)
    pitch = utils.estimate_pitch_yin(y, sr)
    assert pitch is None or isinstance(pitch, (float, int))
