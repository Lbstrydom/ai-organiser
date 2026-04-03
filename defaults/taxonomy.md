# Taxonomy

This file defines your tag taxonomy. The AI uses this to categorize your notes with a consistent structure.

## How It Works

The AI assigns tags in a **3-level hierarchy**:
1. **Theme** - The primary category from the Themes table below
2. **Discipline** - The academic/professional field from the Disciplines table
3. **Topics** - Specific concepts extracted from the content

## Themes

Top-level categories for organizing all your notes. Edit this table to customize your themes.

| Name | Description | Use When |
|------|-------------|----------|
| Technology | Software, hardware, digital tools and systems | Content about tech, software development, digital transformation |
| Strategy | Business strategy, planning, competitive analysis | Strategic planning, market positioning, business models |
| Leadership | Management, team leadership, executive skills | Leading teams, management practices, organizational leadership |
| AI | Artificial intelligence, machine learning, LLMs | ML models, AI applications, neural networks, automation |
| Business | General business operations and practices | Business processes, entrepreneurship, organizational topics |
| Finance | Financial management, accounting, investments | Money management, budgeting, financial analysis |
| Marketing | Marketing strategies, branding, customer acquisition | Campaigns, brand building, market research, advertising |
| Personal-Development | Self-improvement, productivity, learning | Personal growth, habits, skills development |
| Science | Scientific research and discoveries | Research findings, scientific methods, experiments |
| Health | Health, wellness, medical topics | Physical health, mental wellness, medical information |
| Creativity | Creative processes, art, design | Creative work, artistic expression, design thinking |
| Communication | Communication skills, writing, presenting | Writing, public speaking, interpersonal communication |

## Disciplines

Second-level tags representing academic or professional fields. These help bridge themes to specific topics.

| Name | Description | Use When |
|------|-------------|----------|
| computer-science | Programming, algorithms, data structures | Coding, software architecture, computational concepts |
| mathematics | Mathematical concepts and applications | Formulas, proofs, statistical analysis, logic |
| product-management | Product development and lifecycle | Product roadmaps, user research, feature prioritization |
| data-science | Data analysis and visualization | Data pipelines, analytics, visualization, insights |
| psychology | Human behavior and mental processes | Behavioral patterns, cognitive processes, mental health |
| economics | Economic theories and markets | Market dynamics, economic policy, supply and demand |
| project-management | Managing projects and teams | Project planning, agile methods, team coordination |
| design | Visual and UX design principles | UI/UX, graphic design, design systems |

---

## Tips for Customization

1. **Add new themes**: Insert a new row with a unique name and clear description
2. **Remove unused themes**: Delete rows you don't need
3. **Be specific in "Use When"**: This helps the AI understand when to apply each tag
4. **Use kebab-case for disciplines**: e.g., `data-science` not `Data Science`

The AI reads the "Description" and "Use When" columns to understand how to apply each tag.
