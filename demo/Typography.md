# On the Typesetting of Notes

The purpose of a typeface is to disappear. A reader who notices the letters has stopped noticing the argument, and a page that draws attention to its own construction has failed at the one task it was given. This paragraph is long on purpose: it shows how justified text, hyphenation and the measure of the column work together across several lines, and whether the spacing between words stays even rather than opening into rivers.

Knuth's TeX made a particular choice: it considers a whole paragraph at once when deciding where lines break, instead of filling each line greedily. Browsers break lines one at a time, so the closest we can get is justified text with automatic hyphenation and a comfortable column of roughly seventy characters.

## Sections and subsections

Headings follow the conventions of a LaTeX article: a centred title, then bold section headings that sit closer to the text they introduce than to the text above them.

### A subsection

Emphasis is set in *italic*, strong emphasis in **bold**, and `inline code` in typewriter. Quotation marks become "curly" and dashes become proper en dashes -- and em dashes --- automatically.

#### A paragraph heading

Fourth-level headings are italic and run at body size, like `\paragraph` in LaTeX.

## Lists

- An unordered item that is long enough to wrap onto a second line, so the hanging indent is visible.
- A short item.
  - A nested item.

1. First, an ordered item.
2. Second, another.

## Quotation

> We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil.
>
> --- Donald Knuth

## Code

```python
def fourier(f, xi, n=10_000):
    """Approximate the Fourier transform of f at frequency xi."""
    dx = 20 / n
    return sum(f(x) * cmath.exp(-2j * math.pi * x * xi) * dx
               for x in (-10 + k * dx for k in range(n)))
```

## Table

| Method | Order | Stable |
|---|---|---|
| Forward Euler | 1 | Conditionally |
| Backward Euler | 1 | Yes |
| Runge--Kutta 4 | 4 | Conditionally |

---

A horizontal rule appears above as a small ornament, in the manner of a section break in a printed book.
