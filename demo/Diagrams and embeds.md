# Diagrams and embeds 2

## A flowchart

```mermaid
graph LR
  A[Lecture] --> B[Notes]
  B --> C{Understood?}
  C -- yes --> D[Next topic]
  C -- no --> E[Review] --> B
```

## A sequence diagram

```mermaid
sequenceDiagram
  Student->>Quill: Ctrl+E
  Quill->>Disk: autosave
  Quill-->>Student: rendered note
```

## An image

![](assets/figure.svg)

## An animated embed

A local HTML file, running in a sandbox:

::embed[assets/wave.html]

## A broken embed

Plain http and paths outside the folder are refused with a message:

::embed[http://example.com]
