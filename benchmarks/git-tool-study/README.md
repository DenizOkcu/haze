# Git tool token study

This study prepares aggregate measurements from local Haze JSONL sessions and runs an exhaustive sweep of the 12 current Git tool schemas. The checked-in dataset contains counts and token estimates only: it does not contain session identifiers, prompts, commands, paths, repository content, credentials, or tool output. The source session files remain in place and are not modified.

## Run it again

From the Haze repository root, with Node dependencies installed:

```sh
python3 benchmarks/git-tool-study/benchmark.py prepare --sessions "$HOME/.haze/sessions" --output benchmarks/git-tool-study/dataset.json
python3 benchmarks/git-tool-study/benchmark.py run --dataset benchmarks/git-tool-study/dataset.json --output benchmarks/git-tool-study/all-configurations.csv
python3 -m unittest discover -s benchmarks/git-tool-study -p 'test_*.py'
```

Preparation scans sessions once. Subsequent sweeps read only the small dataset and take less than a second. Schema sizes come from the current source catalog and Haze's `estimateToolSchemas`; rerun preparation after changing schemas. Each sweep enumerates all 2¹² = 4,096 subsets.

Options for sensitivity analysis:

```sh
# Assume only 28 model requests receive each selected schema.
python3 benchmarks/git-tool-study/benchmark.py run --dataset benchmarks/git-tool-study/dataset.json --output /tmp/git-sweep.csv --requests 28

# Supply externally measured TOTAL savings over the dataset, per tool.
printf '%s\n' '{"gitDiff": 50000, "gitLog": 10000}' > /tmp/git-savings-assumptions.json
python3 benchmarks/git-tool-study/benchmark.py run --dataset benchmarks/git-tool-study/dataset.json --output /tmp/git-sweep-with-assumptions.csv --savings /tmp/git-savings-assumptions.json
```

The optional savings file is a JSON object whose keys are tool names and values are total projected token savings across the dataset, not per-call averages. These are assumptions, not benchmark measurements. Unspecified tools remain explicitly listed in `unmodeled_tools`.

## What the output means

- `historical_git_part_tokens` estimates each retained Git-containing shell call and result once. Shell commands may combine Git with non-Git work, so this is not Git-only cost or total provider billing.
- Only 28 successful standalone short-status calls have a data-derived result projection. It reconstructs visible paths and uses a placeholder where the branch is missing. Historical worktrees, exact branch/upstream data, provider serialization and later retries are unavailable.
- Each CSV row specifies one set of tool schemas. `schema_total` multiplies Haze's per-request schema estimate by `requests` (by default, all recorded `step_start` events). This is a sensitivity scenario, not a count of tokens billed: some steps may omit a tool, and caching varies.
- `partial_delta_excluding_repeated_history` subtracts schema cost from the one-time projected status savings and any supplied assumptions. **It is not whole-task net savings.** Tool inputs/results can be sent again in subsequent requests; snapshots don't reliably establish the exact provider requests or cache charges. Rows with `unmodeled_tools` lack output projections for those tools. Do not rank configurations or choose tools from this column alone.
- No LLM or Git operations are replayed, no task outcome is assessed, and no tokenization or billing API is called. The estimator is Haze's approximation: four UTF-16 characters per token. Missing command text and parse failures are reported in the dataset.

To decide which tools to ship, augment the dataset with reproducible repository fixtures, run the actual tools, replay representative tasks on the target models, and capture provider-reported input/output/cache tokens, completion rates, and retries. The sweep can then accept measured per-tool assumptions, but interaction effects between tools and dynamic selection still require end-to-end testing.
