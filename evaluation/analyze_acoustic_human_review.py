"""Analyze completed human judgments for the pooled CLAP review sample."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def _graded_ndcg(grades: list[float]) -> float:
    if not grades:
        return 0.0
    gains = [(2.0**grade) - 1.0 for grade in grades]
    discounts = [math.log2(rank + 1) for rank in range(1, len(grades) + 1)]
    dcg = sum(gain / discount for gain, discount in zip(gains, discounts, strict=True))
    ideal = sorted(gains, reverse=True)
    idcg = sum(gain / discount for gain, discount in zip(ideal, discounts, strict=True))
    return dcg / idcg if idcg else 0.0


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def effective_relevance(annotation: dict, *, event_absent_as_irrelevant: bool) -> int:
    """Return the grade used for metrics, optionally zeroing contradictory positives."""
    relevance = int(annotation["relevance"])
    if event_absent_as_irrelevant and annotation.get("event_present") is False and relevance >= 2:
        return 0
    return relevance


def analyze_annotations(
    review_set: dict, annotation_data: dict, *, event_absent_as_irrelevant: bool = False
) -> dict:
    annotations = [
        {
            **annotation,
            "relevance": effective_relevance(
                annotation, event_absent_as_irrelevant=event_absent_as_irrelevant
            ),
        }
        for annotation in annotation_data.get("annotations", [])
    ]
    recoded = sum(
        int(original["relevance"]) != derived["relevance"]
        for original, derived in zip(annotation_data.get("annotations", []), annotations, strict=True)
    )
    judgments: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for annotation in annotations:
        judgments[(annotation["eval_case_id"], int(annotation["segment_id"]))].append(annotation)

    top_k = int(review_set["configuration"]["top_k"])
    complete_cases = []
    incomplete_cases = []
    for case in review_set.get("cases", []):
        top_candidates = [
            candidate for candidate in case["candidates"] if int(candidate["rank"]) <= top_k
        ]
        grades = []
        for candidate in sorted(top_candidates, key=lambda item: item["rank"]):
            segment_id = int(candidate["segment"]["segment_id"])
            item_judgments = judgments.get((case["eval_case_id"], segment_id), [])
            if not item_judgments:
                grades = []
                break
            grades.append(
                float(statistics.median(judgment["relevance"] for judgment in item_judgments))
            )
        if len(grades) != len(top_candidates) or len(top_candidates) != top_k:
            incomplete_cases.append(case["eval_case_id"])
            continue

        binary = [grade >= 2.0 for grade in grades]
        first_relevant = next((rank for rank, value in enumerate(binary, start=1) if value), None)
        fp_cost = sum(
            1.0 / math.log2(rank + 1) for rank, value in enumerate(binary, start=1) if not value
        )
        complete_cases.append(
            {
                "eval_case_id": case["eval_case_id"],
                "category": case["category"],
                "grades": grades,
                "precision_at_k": sum(binary) / top_k,
                "mrr": 1.0 / first_relevant if first_relevant else 0.0,
                "ndcg_at_k": _graded_ndcg(grades),
                "fp_cost_at_k": fp_cost,
            }
        )

    by_category: dict[str, list[dict]] = defaultdict(list)
    for case in complete_cases:
        by_category[case["category"]].append(case)

    return {
        "protocol": review_set.get("review_protocol"),
        "relevance_rule": {
            "event_absent_as_irrelevant": event_absent_as_irrelevant,
            "recoded_judgments": recoded,
        },
        "annotation_count": len(annotations),
        "reviewers": sorted({item.get("reviewer", "anonymous") for item in annotations}),
        "complete_top_k_cases": len(complete_cases),
        "incomplete_case_ids": incomplete_cases,
        "metrics_scope": (
            "Precision, MRR and nDCG are computed on fully judged CLAP top-k rankings."
        ),
        "recall": {
            "available": False,
            "reason": (
                "The pooled sample is not an exhaustive relevance set for all corpus segments. "
                "Corpus-level Recall@k requires exhaustive labels or a substantially deeper pool "
                "formed by independent retrieval systems."
            ),
        },
        "aggregated": {
            f"precision_at_{top_k}": _mean([case["precision_at_k"] for case in complete_cases]),
            "mrr": _mean([case["mrr"] for case in complete_cases]),
            f"ndcg_at_{top_k}": _mean([case["ndcg_at_k"] for case in complete_cases]),
            f"fp_cost_at_{top_k}": _mean([case["fp_cost_at_k"] for case in complete_cases]),
        },
        "by_category": {
            category: {
                "cases": len(cases),
                f"precision_at_{top_k}": _mean([case["precision_at_k"] for case in cases]),
                "mrr": _mean([case["mrr"] for case in cases]),
                f"ndcg_at_{top_k}": _mean([case["ndcg_at_k"] for case in cases]),
                f"fp_cost_at_{top_k}": _mean([case["fp_cost_at_k"] for case in cases]),
            }
            for category, cases in sorted(by_category.items())
        },
        "per_query": complete_cases,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-set", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--event-absent-as-irrelevant",
        action="store_true",
        help="Use relevance 0 when event_present is false and the recorded grade is 2 or 3",
    )
    args = parser.parse_args()

    result = analyze_annotations(
        json.loads(Path(args.review_set).read_text()),
        json.loads(Path(args.annotations).read_text()),
        event_absent_as_irrelevant=args.event_absent_as_irrelevant,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result["aggregated"], indent=2, ensure_ascii=False))
    print(f"Complete cases: {result['complete_top_k_cases']}")


if __name__ == "__main__":
    main()
