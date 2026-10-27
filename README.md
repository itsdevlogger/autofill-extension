# Sheet Autofill (Chrome extension)

Fills web forms (job applications, sign-up pages, …) with your info, read from a Google Sheet.

Default sheet (hard-coded, can be changed in the popup):
https://docs.google.com/spreadsheets/d/1Y-VZWm7ud-6RgqfFTUw32-139CODTokDf-rCnbWyhco/edit?usp=sharing

## Sheet format

The first tab of the sheet holds four columns:

| Field Type | Field Name Type | Field Name | Field Value |
|---|---|---|---|
| `string` | `Text` | `first_name \| firstname \| given-name \| First Name` | Jane |
| `number` | `Text` | `years_experience \| yoe \| Years of Experience` | 5 |
| `number` | `RegEx` | `expected.*(salary\|ctc\|compensation)` | 1500000 |
| `bool` | `Text` | `work_authorized \| authorized_to_work` | TRUE |
| `bool` | `RegEx` | `/require.*sponsor/i` | FALSE |

- **Field Type**: dropdown of `bool`, `string`, `number`.
- **Field Name Type**: dropdown of `Text`, `RegEx`.
- **Field Name**:
  - **Text**: one or more names separated by `|`. Spaces around each name are trimmed.
    A name can be a form field's `name`, `id` or `autocomplete` value, or the text of its label.
    Matching ignores case and punctuation, so `First Name`, `first_name` and `first-name` are the same.
  - **RegEx**: one JavaScript regular expression (`|` means "or" here, not a separator). It is tested,
    as written, against the field's `name`, `id`, `autocomplete` and `data-*` id values, and against its
    label, `aria-label` and placeholder text. It matches anywhere in the text unless you anchor it with
    `^…$`. Matching ignores case by default; write `/pattern/flags` to choose flags yourself
    (for example `/^Website$/` is case-sensitive). Invalid patterns are skipped and listed in the popup.
- **Field Value**: what to type. `bool` rows hold `TRUE` / `FALSE`.

When a field matches more than one row, the row nearest the top of the sheet wins.
The old three-column layout (no Field Name Type) still works; every row is treated as Text.

`template/autofill-template.xlsx` is an empty copy of this layout, with the dropdown, if you want to start a new sheet
(File → Import in Google Sheets).

The sheet must be shared as **Anyone with the link → Viewer**, or you must be signed in to Google in the
same Chrome profile. To read a tab other than the first, paste a link that includes `#gid=…` into the popup.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder of this repo.
4. Pin **Sheet Autofill** from the puzzle-piece menu.

## Use

- Open a form, click the extension icon, then **Fill this page**. Or press **Alt+Shift+F**
  (change it at `chrome://extensions/shortcuts`).
- Filled fields flash green. Fields that already have a value are left alone unless you tick
  **Overwrite fields that already have a value**.
- The sheet is cached for 5 minutes. Click **Refresh** after editing the sheet to pick up changes right away.
  If the sheet can't be reached, the last saved copy is used.

What gets filled:

- Text inputs, text areas, email/phone/number/date inputs.
- Dropdowns (`<select>`): picks the option whose text matches the value.
- Checkboxes and Yes/No radio buttons or dropdowns, from `bool` rows.
- Fields inside iframes (for example embedded Greenhouse/Lever forms) and open shadow DOM.

Password and file-upload fields are never touched.

## How fields are matched

For each field on the page, the steps run in order and the first one that finds a row wins:

1. The field's `name`, `id`, `autocomplete` or `data-automation-id`/`data-testid` equals a Text name
   (also the last part of names like `job_application[first_name]`), or a RegEx matches one of them.
2. Its label, `aria-label` or placeholder equals a Text name (`First Name *` → `first name`),
   or a RegEx matches it.
3. A Text name appears as whole words inside the label (`What is your first name?`).
   Longer names win, so `Confirm email` beats `email`. RegEx rows are not used in this step.

In steps 1 and 2, if several rows match, the one nearest the top of the sheet wins.

If a field is missed, add its name or label text to the right row's Field Name, separated by `|`,
or add a RegEx row for it.
