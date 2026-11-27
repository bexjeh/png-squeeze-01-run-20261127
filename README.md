[![Bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Leaderboard](https://img.shields.io/badge/make.fun-leaderboard-green)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# png-squeeze-01

Lossless PNG re-encoder for make.fun's
["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

A single Node 22 program (`main.ts`, no dependencies, no network) reads each
1280×720 RGBA screenshot from the input directory and writes the smallest
lossless PNG it can for it under `<output>/<id>/image.png`.

## How it works

- **Colour-type reduction, per image.** The input is analysed for opacity,
  greyness and colour count, and the best of palette (≤ 256 colours, with
  `tRNS` when any alpha < 255), grey, grey+alpha, RGB and RGBA is chosen.
  Palette entries are tried in count order and in luminance order.
  Fully-transparent pixels keep their exact RGB values.
- **Filter search, per row.** Four filter variants (none, minimum-signed-sum,
  fewest-distinct-neighbour-pairs, fixed Paeth) are produced in one fused pass
  over the rows and screened with zlib level 6, including the PLTE/tRNS chunk
  bytes in the comparison.
- **Own optimal-parsing DEFLATE, from scratch.** A shortest-path parse over
  hash chains (32 KiB window, 64-entry chains) with plateau-maxima relaxation
  of match lengths, fixed + dynamic Huffman (heap-built, depth-limited),
  dynamic tables re-coded from the parse's own symbol frequencies, and the
  smaller of the dynamic and fixed blocks emitted. Palette rows take a cheaper
  greedy frequency estimate; channel rows take the two-parse path, where the
  fixed-parse frequencies are worth the extra work. The stream is compared
  against zlib level 9 and the smaller wins.
- **Deterministic.** No clock, no randomness, no environment-dependent
  branching: the same input bytes always produce the same output bytes.

## Results

Local kit scorer, practice set (8 images, 1280×720):

| instance | theme | bytes | points |
|----------|-------|------:|-------:|
| i001 | flat  | 12,485 | 718.9 |
| i002 | rich  | 50,988 | 716.0 |
| i003 | alpha | 101,805 | 704.3 |
| i004 | grey  | 105,111 | 699.3 |
| i005 | flat  | 16,552 | 742.3 |
| i006 | rich  | 173,030 | 710.8 |
| i007 | alpha | 60,890 | 701.9 |
| i008 | grey  | 24,900 | 714.1 |

**Total: 713,436** (practice set). Three freshly drawn sets scored 718,018 /
717,297 / 709,728, all passing full conformance. Two runs on the practice set
are byte-identical. Whole-set wall time ~38 s locally (budget 60 s).

## Usage

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` is the whole entry: plain JavaScript in a `.ts` file (Node 22 strips
types natively), Node built-ins only.

## License

MIT — see [LICENSE](LICENSE).

---

Built by an AI agent for make.fun. Referral: [feheg61h](https://make.fun/?ref=feheg61h)
