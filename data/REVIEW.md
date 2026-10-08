# Client list: items to review before going live

Generated from `Company_details_sector_wise.xlsx`. The sectors band on the page is built from that
sheet by `build_sectors.py`; re-run it after editing the sheet (see the README).

## Not shown on the page

**53 businesses have no sector** (Segment = `NA`, 119 rows, 54 names as written). The panel is organised by industry, so
they have nowhere to go. Give each one a segment in the sheet and re-run the build. These include
an apparent individual's name (`ASHWIN MOHTA`), a row holding two companies
(`Techmate & Fincrop services Sona Biscuits Ltd`), and spelling variants of the same company
(`KALPANA DIGITAL` / `KALPANA DIGITALS` / `KALPANA DEGITAL` / `M/S KALPANA DIGITALS`,
`INFINITY LINE SOLUTIONS` / `INFINITYLINE SOLUTIONS`).

## Shown, but worth a second look

- **Probable typos in the sheet**, shown as written: `CLOUDASTURCTURE INDUA` (also listed correctly
  as `CLOUDASTRUCTURE INDIA`), `MOJUTECH SOLUATION`, `FUTION TECHNOSOLUTIONS`,
  `BHANDARI AUTOMIBILES`, `THE CALCUTTA HOMOEOPATHIC MEDICAL COLLAGE AND HOSPITAL`.
- **Entries that read like notes rather than client names:**
  `Virtual office Functioning at Seniour IAS officers`, `High court Calcutta bar Library club and ils`,
  `State Lotteries PWD`, `RAJPUR`, `SUJANYA`.
- **Named after an individual:** `MS DR. SANJIB PAL` (Healthcare).
- **Odd location:** `JIS UNIVERSITY` is listed in `Austin` (rows 49 and 50). That is shown on the page as
  written; correct it in the sheet if it should be a West Bengal location.
- **Consent:** this publishes 244 customer names and their branch locations. Make sure your
  customer agreements allow it.

## How the sheet was turned into the page

- The page does not show client counts (no numbers on the sector chips, in the list headers or in
  the section subtitle). Each list header shows only how many districts that sector spans.

- Display names drop legal suffixes (Pvt Ltd, Private Limited, Limited, LLP), an `M/S` prefix and
  stray trailing counters such as `... LTD 1`. Names are shown in capitals, exactly as spelled.
- Rows for the same company are merged; each location becomes `Location, District`. `NA` values
  are omitted.
- Eight companies written two ways were merged (for example `PVT LTD` vs `PRIVATE LIMITED`).
- Three tiny segments were folded into a neighbour: Agriculture & Plantation and FMCG & Consumer
  Goods into **Food & FMCG**; Travel & Tourism into **Hospitality**.
- `Education & Healthcare` (4 medical colleges and a hospital) appears under both Education and
  Healthcare.
