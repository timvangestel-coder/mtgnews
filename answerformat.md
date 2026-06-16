# Chat Answer Format

## Desired Output

```
**Why Do Strange Things Happen Under a Full Moon? | Cosmic Queries #112**

| Timestamp | Finding |
|-----------|---------|
| [02:13]   | Deep space relay nodes proposed as fuel stations for missions |
| [09:40]   | Scientific impossibilities usually engineering challenges not physics violations |

**What Are We Replacing the ISS With? With Ariel Ekblaw**

| Timestamp | Finding |
|-----------|---------|
| [07:05]   | ISS decommissioning by 2031 transitions LEO to commercial operators |
| [11:30]   | Self-assembling magnetic tiles for in-orbit construction |

astrophysics-demystification · space-infrastructure · commercialization
```

---

## Implementation Requirements

### Format Structure
For each source, present findings as an annotated index using this exact structure:

```
**Source Title Here**

| Timestamp | Finding |
|-----------|---------|
| [02:13]   | Relay nodes proposed as fuel stations for missions |
| [09:40]   | Impossibilities usually engineering challenges not physics violations |
```

### Critical Rules
- Each source gets its own **bold title** on a separate line above the table
- The table MUST have: header row, separator row, then data rows (each on its own line)
- Header row: `| Timestamp | Finding |`
- Separator row: `|-----------|---------|`
- Each finding is ONE row: `| [MM:SS]   | Finding text here |`
- Do not add inline citations after individual findings (source title provides context)