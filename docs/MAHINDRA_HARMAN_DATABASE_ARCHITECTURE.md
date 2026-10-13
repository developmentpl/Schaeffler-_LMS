# Mahindra LMS Harman-Style Database Architecture

Date: 2026-06-27
Target schema: `yyscheafller_aaplication`
Target project: E:\Developement\Mahindra replica\Software\R1 Mahindra
Source references:
- Mahindra LMS: E:\Developement\Mahindra\Sostware\R1_Mahindra Electric LMS (22-09-2025 12.45pm)
- Harman ARS: E:\Developement\Harman\1. Harman Ars\Software\R3_Harman_ARS (22-01-2026_6.42 pm)

## Goal

Create a new Mahindra LMS database architecture that follows Harman's normalized hierarchy and attempt/grade storage, while preserving Mahindra's existing employee login and SCORM course behavior.

The existing Mahindra project stores course eligibility through department/tag names and wide user/course columns. The new design stores IDs and relationships like Harman:

`departments -> areas -> mcourses -> comaincourses -> subcourses`

This replica is intended as a fresh system. Old Mahindra data should not be migrated unless explicitly requested later. Admins will create new departments, segments, processes, courses, users, and enrollments from the beginning.

Mahindra UI labels can be:

- `departments` = Department
- `areas` = Segment / Area
- `mcourses` = Process / Line
- `comaincourses` = hidden default Course Group
- `subcourses` = Actual course item shown to user

## Non-Negotiables

- Do not touch the current Harman project.
- Do not touch the current Mahindra project.
- Build this only in the new Mahindra replica project.
- Keep Harman table and column names where they are part of course/user/grade/enrollment architecture.
- Preserve Mahindra SCORM uploads and launch/tracking behavior.
- Replace name-based course assignment with ID-based assignment.
- Keep only two active sides for Mahindra: Admin and User/Employee.
- No RF keypad/hardware dependency in Mahindra.

## Main Architecture

### 1. Users And Admins

Use Harman-style `users` and `admins` tables.

Mahindra employee login continues through `users.uName`, `users.uPass`, `users.employeeID`, and `users.uniqueID`.

Recommended Mahindra additions:

- Preserve old Mahindra user ID during migration using `mahindraOldUserID`.
- Preserve old Mahindra text unique ID if needed using `mahindraOldUniqueID`.
- Add optional `licenseIssueDate` because Mahindra currently has license/certificate related fields.

### 2. Course Hierarchy

Use Harman names and IDs:

- `departments.deptID`
- `areas.areaID`, linked to `deptID`
- `mcourses.mCourseID`, linked to `deptID`, `areaID`
- `comaincourses.coMCourseID`, linked to `deptID`, `areaID`, `mCourseID`
- `subcourses.subCourseID`, linked to all parent IDs

Mahindra's current `department` table becomes `departments`.
Mahindra's current course tag/category concept becomes hierarchy IDs, not text stored inside courses.

Mahindra does not expose Station in the UI. For Harman column compatibility, every Process/Line gets one hidden/default `comaincourses` row. Admins create courses directly under a Process/Line, and the backend attaches those courses to the line's default `coMCourseID`.

### 3. Subcourses As Mahindra Course Items

Every visible course in user My Courses should be a `subcourses` row.

Course types should be stored in a new column `courseType`, while keeping Harman's existing columns:

- `training`
- `assessment`
- `practical`
- `ojt_observation`
- `scorm`

Content template should be stored in `contentType`:

- `ppt`
- `pdf`
- `video`
- `excel`
- `scorm_zip`
- `excel_with_ppt`
- `video_with_excel`
- `practical_template`
- `observation_template`

Existing Harman columns still remain:

- `subCoursePath`
- `subCoursePassing`
- `isOnlyTraining`
- `practicalExam`
- `duration`

Mahindra SCORM-specific preservation fields:

- `scormPath`
- `scormCourseID`
- `scormManifestPath`
- `scormVersion`
- `scormLaunchFile`

### 4. Enrollment

Use Harman `enrollstatus` table.

When an admin enrolls a user into a Process/Line:

- Store `uniqueID`
- Store `deptID`, `areaID`, `mCourseID`, `coMCourseID`
- Keep `subCourseID` nullable when enrollment is for the whole process/line

User My Courses should be populated by joining `enrollstatus` with `subcourses`:

- If `enrollstatus.subCourseID` is set, show only that subcourse.
- If `enrollstatus.coMCourseID` is set and `subCourseID` is null, show all subcourses under the hidden default course group.
- If `enrollstatus.mCourseID` is set and lower IDs are null, show all eligible station subcourses under that process/line.

### 5. Attempts And Question Paper Storage

Use Harman tables:

- `courseattempts`
- `attempts_items`
- `coursegrades`
- `traininggrades`

For Excel/non-SCORM assessments:

- Create one `courseattempts` row per attempt.
- Store every shown question and selected answer in `attempts_items`.
- Store final marks/status in `coursegrades`.

For training-only completion:

- Store completion in `traininggrades`.

For SCORM:

- Keep Mahindra SCORM runtime behavior initially.
- Store overall attempt summary in `courseattempts`/`coursegrades` when available.
- Store raw SCORM runtime payloads in new table `scorm_attempt_data` so no data is lost even if detailed question mapping is not ready.

### 6. Practical And Observation

Keep Harman practical/observation structure:

- `practical_evaluations`
- `practical_evaluation_observations`
- `practical_evaluation_actionplans`
- `ojt_feedbacks`

Mahindra does not need trainer-side role workflow now, so `trainerUniqueID`, `trainerID`, and `createdBy` may be nullable or filled by admin ID.

### 7. Reports And Grade Management

Admin reports should be based on joins across:

- `users`
- `enrollstatus`
- `departments`
- `areas`
- `mcourses`
- `comaincourses`
- `subcourses`
- `courseattempts`
- `attempts_items`
- `coursegrades`
- `traininggrades`
- practical/observation tables

This replaces Mahindra's old per-course tables such as `course_1`, `course_2`, etc.

## Legacy Reference Mapping

| Old Mahindra | New Harman-Style Mahindra |
|---|---|
| `department.id` | `departments.deptID` |
| `department.mCourseName` | `departments.deptName` |
| `courses.id` | `subcourses.subCourseID` or `subcourses.mahindraOldCourseID` |
| `courses.courseName` | `subcourses.subCourseName` |
| `courses.courseDescription` | `subcourses.subCourseDescription` |
| `courses.courseDate` | `subcourses.subCourseDate` |
| `courses.courseTeacher` | `subcourses.subCourseTeacher` |
| `courses.scormPath` | `subcourses.subCoursePath` and `subcourses.scormPath` |
| `courses.courseID` | `subcourses.scormCourseID` or `mahindraOldCourseID` |
| `courses.level` | `subcourses.subCourseLevel` |
| `courses.department` text | `subcourses.deptID` |
| `courses.mCourseName` tag text | hierarchy IDs: `areaID`, `mCourseID`, `coMCourseID` |
| `users.uCourse1..uCourse65` | `enrollstatus` rows |
| `course_1..course_14` | `courseattempts`, `attempts_items`, `coursegrades` |

This table is only a reference for understanding old code. For the fresh system, do not run data migration.

## Required App Changes After Schema

1. Admin course management
   - Add Department, Segment/Area, Process/Line, Station screens.
   - Course creation must select parent IDs, not names.
   - Course type decides upload template and validation.

2. User My Courses
   - Fetch eligible courses from `enrollstatus` plus `subcourses`.
   - Do not read `users.uCourse1..uCourse65`.

3. Attempt save
   - For Excel assessment, save attempt header in `courseattempts`, question rows in `attempts_items`, and result in `coursegrades`.
   - For training, save completion in `traininggrades`.
   - For SCORM, keep current launch/runtime and additionally save summary plus raw runtime data.

4. Reports
   - Rebuild grade reports on normalized attempt/grade tables.

## Open Decisions Needed From Client

- Should enrollment happen at Process/Line level only, Station level only, or both?
- Are Levels still needed like Mahindra `levels`, or should Harman `subCourseLevel` be enough?
- Should SCORM detailed question-level response be mandatory later, or is raw SCORM payload plus score/status acceptable for phase 1?

## Recommended Phase 1 Scope

- Create new schema.
- Keep the new schema empty for fresh master data entry.
- Build hierarchy management in admin.
- Build course creation templates for training, assessment, practical, OJT observation, SCORM.
- Build enrollment by process/station.
- Update My Courses to use enrollment and subcourses.
- Update non-SCORM attempt/grade saving to Harman-style tables.
- Preserve SCORM launch and add raw SCORM tracking table.
