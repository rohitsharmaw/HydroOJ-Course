# HydroOJ-Course

Course plugin for HydroOJ v5 - Enhanced training + homework functionality for classroom use.

## Features

- **Create Courses**: Create courses with introduction, problems, and file attachments
- **Multiple Classes**: Support for multiple classes/groups per course
- **Multiple Teachers**: Assign multiple teachers to a course
- **Student Progress Tracking**: Track individual student progress through the course
- **File/Lecture Upload**: Upload lecture materials and course files
- **Class Management**: Manage students by class/group
- **Scoreboard**: View student scores and progress

## Installation

```bash
# Install from npm (when published)
yarn add @hydrooj/course

# Or install from local directory
cd /path/to/hydro
yarn add /path/to/HydroOJ-Course
```

## Permissions

This plugin uses the Homework permissions from HydroOJ:

- `PERM_VIEW_HOMEWORK` - View courses
- `PERM_CREATE_HOMEWORK` - Create courses
- `PERM_ATTEND_HOMEWORK` - Join courses
- `PERM_EDIT_HOMEWORK` - Edit any course
- `PERM_EDIT_HOMEWORK_SELF` - Edit own courses
- `PERM_VIEW_HOMEWORK_SCOREBOARD` - View course scoreboard
- `PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD` - View hidden scoreboard
- `PERM_VIEW_HIDDEN_HOMEWORK` - View hidden courses

## Routes

| Route | Path | Description |
|-------|------|-------------|
| `course_main` | `/course` | Course list |
| `course_create` | `/course/create` | Create new course |
| `course_detail` | `/course/:cid` | Course detail page |
| `course_edit` | `/course/:cid/edit` | Edit course |
| `course_files` | `/course/:cid/file` | Manage course files |
| `course_file_download` | `/course/:cid/file/:filename` | Download course file |
| `course_scoreboard` | `/course/:cid/scoreboard` | View scoreboard |

## Navigation

The course entry appears in the top navigation bar, positioned after Training and before Contest.

## Compatibility

- HydroOJ v5 beta-16 or later

## License

AGPL-3.0-or-later
