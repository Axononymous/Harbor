# Adding games to Harbor

Place each game in its own folder under `games/`. Harbor discovers the folders
through the GitHub API and prefers `index.html` as the launch page. If a game
uses another HTML file, Harbor will choose a common entry name (`game.html`,
`play.html`, `main.html`, or `start.html`) or the first HTML file it finds.

```text
games/
  <game-folder>/
    index.html
    metadata.json   (optional)
    assets/
```

Optional `metadata.json` may contain string fields such as `title`,
`description`, `genre`, and `thumbnail`. A thumbnail path is relative to that
game folder. The `game.json` and `info.json` filenames are also recognized.

Only folders containing an HTML page appear as games in Harbor.
