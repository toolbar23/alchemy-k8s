# Show the available repository tasks.
default:
    @just --list

# Preview package contents and the complete release without publishing.
release-dry-run:
    mise run publish:dry-run

# Run all release gates and bootstrap unpublished packages on npm.
release:
    mise run publish
