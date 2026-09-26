"""Tests for metrics derived from completed acoustic human review."""

from evaluation.analyze_acoustic_human_review import analyze_annotations


def test_analyze_annotations_uses_complete_top_k_and_graduated_relevance():
    review_set = {
        "review_protocol": "human_relevance_grading_0_to_3",
        "configuration": {"top_k": 2},
        "cases": [
            {
                "eval_case_id": "q1",
                "category": "voice",
                "candidates": [
                    {"rank": 1, "segment": {"segment_id": 10}},
                    {"rank": 2, "segment": {"segment_id": 20}},
                    {"rank": 25, "segment": {"segment_id": 30}},
                ],
            }
        ],
    }
    annotations = {
        "annotations": [
            {"eval_case_id": "q1", "segment_id": 10, "relevance": 3, "reviewer": "a"},
            {"eval_case_id": "q1", "segment_id": 20, "relevance": 0, "reviewer": "a"},
        ]
    }

    result = analyze_annotations(review_set, annotations)

    assert result["complete_top_k_cases"] == 1
    assert result["aggregated"]["precision_at_2"] == 0.5
    assert result["aggregated"]["mrr"] == 1.0
    assert result["recall"]["available"] is False


def test_analyze_annotations_excludes_incomplete_queries():
    review_set = {
        "configuration": {"top_k": 2},
        "cases": [
            {
                "eval_case_id": "q1",
                "category": "voice",
                "candidates": [
                    {"rank": 1, "segment": {"segment_id": 10}},
                    {"rank": 2, "segment": {"segment_id": 20}},
                ],
            }
        ],
    }

    result = analyze_annotations(
        review_set,
        {"annotations": [{"eval_case_id": "q1", "segment_id": 10, "relevance": 2}]},
    )

    assert result["complete_top_k_cases"] == 0
    assert result["incomplete_case_ids"] == ["q1"]


def test_event_absent_rule_zeroes_contradictory_positive_grades():
    review_set = {
        "configuration": {"top_k": 2},
        "cases": [
            {
                "eval_case_id": "q1",
                "category": "environment",
                "candidates": [
                    {"rank": 1, "segment": {"segment_id": 10}},
                    {"rank": 2, "segment": {"segment_id": 20}},
                ],
            }
        ],
    }
    annotations = {
        "annotations": [
            {"eval_case_id": "q1", "segment_id": 10, "relevance": 2, "event_present": False},
            {"eval_case_id": "q1", "segment_id": 20, "relevance": 2, "event_present": None},
        ]
    }

    raw = analyze_annotations(review_set, annotations)
    derived = analyze_annotations(review_set, annotations, event_absent_as_irrelevant=True)

    assert raw["aggregated"]["precision_at_2"] == 1.0
    assert derived["aggregated"]["precision_at_2"] == 0.5
    assert derived["aggregated"]["mrr"] == 0.5
    assert derived["relevance_rule"] == {"event_absent_as_irrelevant": True, "recoded_judgments": 1}
    assert annotations["annotations"][0]["relevance"] == 2
