-- Mahindra LMS Harman-style schema draft
-- Date: 2026-06-27
-- Purpose: New Mahindra replica architecture based on Harman table/column names,
-- while preserving Mahindra employee login and SCORM functionality.

CREATE DATABASE IF NOT EXISTS `yyscheafller_aaplication` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE `yyscheafller_aaplication`;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `scorm_attempt_data`;
DROP TABLE IF EXISTS `practical_evaluation_actionplans`;
DROP TABLE IF EXISTS `practical_evaluation_observations`;
DROP TABLE IF EXISTS `practical_evaluations`;
DROP TABLE IF EXISTS `ojt_feedbacks`;
DROP TABLE IF EXISTS `traininggrades`;
DROP TABLE IF EXISTS `coursegrades`;
DROP TABLE IF EXISTS `attempts_items`;
DROP TABLE IF EXISTS `courseattempts`;
DROP TABLE IF EXISTS `enrolllogs`;
DROP TABLE IF EXISTS `enrollstatus`;
DROP TABLE IF EXISTS `subcourses`;
DROP TABLE IF EXISTS `comaincourses`;
DROP TABLE IF EXISTS `mcourses`;
DROP TABLE IF EXISTS `areas`;
DROP TABLE IF EXISTS `departments`;
DROP TABLE IF EXISTS `admins`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `levels`;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE `departments` (
  `deptID` int NOT NULL AUTO_INCREMENT,
  `deptName` text,
  `deptDescription` text,
  `deptDate` date DEFAULT NULL,
  `deptOwner1Name` text,
  `deptOwner1UniqueID` int DEFAULT NULL,
  `deptOwner2Name` text,
  `deptOwner2UniqueID` int DEFAULT NULL,
  PRIMARY KEY (`deptID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `areas` (
  `areaID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaName` text,
  `areaDescription` text,
  `areaDate` date DEFAULT NULL,
  `areaOwner1Name` text,
  `areaOwner1UniqueID` int DEFAULT NULL,
  `areaOwner2Name` text,
  `areaOwner2UniqueID` int DEFAULT NULL,
  PRIMARY KEY (`areaID`),
  KEY `idx_areas_dept` (`deptID`),
  CONSTRAINT `fk_areas_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `mcourses` (
  `mCourseID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseName` text,
  `mCourseDescription` text,
  `mCourseDate` text,
  `mCourseTags` text,
  `mCourseTeacher` text,
  `mCourseLevel` text,
  `mCourseRemark` text,
  `mCourseTeacherUniqueID` text,
  PRIMARY KEY (`mCourseID`),
  KEY `idx_mcourses_dept_area` (`deptID`,`areaID`),
  CONSTRAINT `fk_mcourses_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_mcourses_area` FOREIGN KEY (`areaID`) REFERENCES `areas` (`areaID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `comaincourses` (
  `coMCourseID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseName` text,
  `coMCourseDescription` text,
  `coMCourseDate` text,
  `coMCourseTags` text,
  `coMCourseTeacher` text,
  `coMCourseLevel` text,
  `coMCourseTeacherUniqueID` text,
  `coMCourseRemark` text,
  `requiredSkillLevel` varchar(45) DEFAULT NULL,
  `cpCi` varchar(45) DEFAULT NULL,
  `manPowerRequired` int DEFAULT NULL,
  `comonID` text,
  `isDefaultForLine` tinyint(1) NOT NULL DEFAULT '1',
  PRIMARY KEY (`coMCourseID`),
  KEY `idx_comain_hierarchy` (`deptID`,`areaID`,`mCourseID`),
  CONSTRAINT `fk_comain_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_comain_area` FOREIGN KEY (`areaID`) REFERENCES `areas` (`areaID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_comain_mcourse` FOREIGN KEY (`mCourseID`) REFERENCES `mcourses` (`mCourseID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Mahindra does not expose Station in the UI.
-- For each Process/Line (`mcourses`) create one hidden/default `comaincourses` row
-- and attach all `subcourses` to that row through `coMCourseID`.

CREATE TABLE `subcourses` (
  `subCourseID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseName` text,
  `subCourseDescription` text,
  `subCourseDate` text,
  `subCourseTags` text,
  `subCourseTeacher` text,
  `subCourseLevel` text,
  `subCourseTeacherUniqueID` text,
  `subCoursePath` text,
  `subCourseRefreshDate` date DEFAULT NULL,
  `subCourseCompletionDate` text,
  `subCourseRevisionDate` date DEFAULT NULL,
  `subCourseRevisionNumber` varchar(100) DEFAULT NULL,
  `subCourseDocumentNo` varchar(100) DEFAULT NULL,
  `subCourseRemark` text,
  `subCourseIssueDate` date DEFAULT NULL,
  `subCourseDocAuthorised` text,
  `subCourseFormatNo` varchar(100) DEFAULT NULL,
  `practicalExam` text,
  `subCoursePassing` int DEFAULT NULL,
  `isOnlyTraining` varchar(45) DEFAULT NULL,
  `subcoursescol` varchar(45) DEFAULT NULL,
  `subCourseTeacher2` text,
  `subCourseTeacher2UniqueID` int DEFAULT NULL,
  `subCourseLockTag` varchar(45) DEFAULT NULL,
  `duration` time DEFAULT NULL,
  `courseType` enum('training','assessment','practical','ojt_observation','scorm') DEFAULT 'training',
  `contentType` enum('ppt','pdf','video','excel','scorm_zip','excel_with_ppt','video_with_excel','practical_template','observation_template') DEFAULT NULL,
  `scormPath` text,
  `scormCourseID` int DEFAULT NULL,
  `scormManifestPath` text,
  `scormVersion` varchar(45) DEFAULT NULL,
  `scormLaunchFile` text,
  `mahindraOldCourseID` int DEFAULT NULL,
  PRIMARY KEY (`subCourseID`),
  KEY `idx_subcourses_hierarchy` (`deptID`,`areaID`,`mCourseID`,`coMCourseID`),
  KEY `idx_subcourses_course_type` (`courseType`),
  CONSTRAINT `fk_subcourses_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_area` FOREIGN KEY (`areaID`) REFERENCES `areas` (`areaID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_mcourse` FOREIGN KEY (`mCourseID`) REFERENCES `mcourses` (`mCourseID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_comain` FOREIGN KEY (`coMCourseID`) REFERENCES `comaincourses` (`coMCourseID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `users` (
  `uniqueID` int NOT NULL AUTO_INCREMENT,
  `name` text,
  `emailID` text,
  `employeeID` text,
  `uName` text,
  `uPass` text,
  `photo` text,
  `photoPath` text,
  `dateOfJoining` text,
  `dateOfBirth` text,
  `address` text,
  `mobileNo` text,
  `department` text,
  `uRole` text,
  `registerDate` text,
  `registerTime` text,
  `lastLoggedIn` text,
  `qualification` text,
  `contract` text,
  `contractorName` text,
  `status` text,
  `skillLevel` text,
  `rfid` text,
  `rfidIssueDate` text,
  `userTags` text,
  `remark` text,
  `batchNumber` int DEFAULT NULL,
  `batchDate` text,
  `catergory` text,
  `preExperience` text,
  `experiencefield` varchar(50) DEFAULT NULL,
  `ipcCertificate` text,
  `ipcCertifiedDate` date DEFAULT NULL,
  `jobCardIssue` varchar(45) DEFAULT NULL,
  `jobCardIssueDate` date DEFAULT NULL,
  `mahindraOldUserID` int DEFAULT NULL,
  `mahindraOldUniqueID` text,
  `licenseIssueDate` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`uniqueID`),
  KEY `idx_users_employee` (`employeeID`(50)),
  KEY `idx_users_uname` (`uName`(50))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admins` (
  `uniqueID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `name` text,
  `emailID` text,
  `employeeID` text,
  `uName` text,
  `uPass` text,
  `photo` text,
  `photoPath` text,
  `dateOfJoining` text,
  `dateOfBirth` text,
  `address` text,
  `mobileNo` text,
  `department` text,
  `uRole` text,
  `registerDate` text,
  `registerTime` text,
  `lastLoggedIn` text,
  `qualification` text,
  `contract` text,
  `contractorName` text,
  `status` text,
  `skillLevel` text,
  `rfid` text,
  `rfidIssueDate` text,
  `userTags` text,
  `remark` text,
  `batchNumber` text,
  `batchDate` text,
  `category` text,
  `preExperience` text,
  PRIMARY KEY (`uniqueID`),
  KEY `idx_admins_dept_area` (`deptID`,`areaID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `enrollstatus` (
  `enrollID` int NOT NULL AUTO_INCREMENT,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `enrollDate` text,
  `startDate` date DEFAULT NULL,
  `endDate` date DEFAULT NULL,
  `enrollStatus` text,
  `multiSkill` varchar(45) DEFAULT NULL,
  `activeTrainingStations` int DEFAULT NULL,
  PRIMARY KEY (`enrollID`),
  KEY `idx_enroll_user` (`uniqueID`),
  KEY `idx_enroll_hierarchy` (`deptID`,`areaID`,`mCourseID`,`coMCourseID`,`subCourseID`),
  CONSTRAINT `fk_enroll_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `enrolllogs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `enrollID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `action` varchar(50) DEFAULT NULL,
  `actionBy` int DEFAULT NULL,
  `actionDate` datetime DEFAULT CURRENT_TIMESTAMP,
  `remark` text,
  PRIMARY KEY (`id`),
  KEY `idx_enrolllogs_user` (`uniqueID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `courseattempts` (
  `attemptID` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `noOfAttempts` int DEFAULT NULL,
  `pretestScore` float DEFAULT NULL,
  `score` float DEFAULT NULL,
  `status` text,
  `duration` text,
  `courseDate` date DEFAULT NULL,
  `courseTime` time DEFAULT NULL,
  `allowThirdAttempt` varchar(45) DEFAULT NULL,
  `attemptRemark` text,
  PRIMARY KEY (`attemptID`),
  KEY `idx_attempts_user_subcourse` (`uniqueID`,`subCourseID`),
  KEY `idx_attempts_hierarchy` (`deptID`,`areaID`,`mCourseID`,`coMCourseID`,`subCourseID`),
  CONSTRAINT `fk_attempts_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_attempts_subcourse` FOREIGN KEY (`subCourseID`) REFERENCES `subcourses` (`subCourseID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `attempts_items` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `attemptID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `questionText` mediumtext,
  `optionAText` text,
  `optionBText` text,
  `optionCText` text,
  `optionDText` text,
  `practicalAnswer` text,
  `userAnswer` text,
  `isCorrect` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_attempt_items_attempt` (`attemptID`),
  KEY `idx_attempt_items_subcourse` (`subCourseID`),
  CONSTRAINT `fk_attempt_items_attempt` FOREIGN KEY (`attemptID`) REFERENCES `courseattempts` (`attemptID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coursegrades` (
  `id` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `attemptID` int DEFAULT NULL,
  `noOfAttempts` int DEFAULT NULL,
  `pretestScore` float DEFAULT NULL,
  `score` float DEFAULT NULL,
  `status` text,
  `duration` text,
  `courseDate` text,
  `courseTime` text,
  `trainerUniqueID` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_coursegrades_user_subcourse` (`uniqueID`,`subCourseID`),
  KEY `idx_coursegrades_attempt` (`attemptID`),
  CONSTRAINT `fk_coursegrades_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_coursegrades_attempt` FOREIGN KEY (`attemptID`) REFERENCES `courseattempts` (`attemptID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `traininggrades` (
  `id` int NOT NULL AUTO_INCREMENT,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `noOfAttemptss` int DEFAULT NULL,
  `pretestScore` float DEFAULT NULL,
  `score` float DEFAULT NULL,
  `status` text,
  `duration` int DEFAULT NULL,
  `courseDate` text,
  `courseTime` text,
  `trainerUniqueID` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_traininggrades_user_subcourse` (`uniqueID`,`subCourseID`),
  CONSTRAINT `fk_traininggrades_user` FOREIGN KEY (`uniqueID`) REFERENCES `users` (`uniqueID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `scorm_attempt_data` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `attemptID` int DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `scormElement` varchar(255) DEFAULT NULL,
  `scormValue` longtext,
  `rawPayload` json DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_scorm_attempt` (`attemptID`),
  KEY `idx_scorm_user_subcourse` (`uniqueID`,`subCourseID`),
  CONSTRAINT `fk_scorm_attempt` FOREIGN KEY (`attemptID`) REFERENCES `courseattempts` (`attemptID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `practical_evaluations` (
  `practicalEvalID` bigint NOT NULL AUTO_INCREMENT,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `trainerUniqueID` int DEFAULT NULL,
  `testDate` date DEFAULT NULL,
  `cycle1StandardQty` decimal(10,2) DEFAULT NULL,
  `cycle1ActualQty` decimal(10,2) DEFAULT NULL,
  `cycle1PerformancePct` decimal(6,2) DEFAULT NULL,
  `cycle1RejectQty` decimal(10,2) DEFAULT NULL,
  `cycle1DefectName` text,
  `cycle1FpyPct` decimal(6,2) DEFAULT NULL,
  `cycle1Reason` text,
  `cycle1Result` enum('Pass','Fail','Pending') DEFAULT 'Pending',
  `cycle1Mark` int DEFAULT NULL,
  `cycle2StandardQty` decimal(10,2) DEFAULT NULL,
  `cycle2ActualQty` decimal(10,2) DEFAULT NULL,
  `cycle2PerformancePct` decimal(6,2) DEFAULT NULL,
  `cycle2RejectQty` decimal(10,2) DEFAULT NULL,
  `cycle2DefectName` text,
  `cycle2FpyPct` decimal(6,2) DEFAULT NULL,
  `cycle2Reason` text,
  `cycle2Result` enum('Pass','Fail','Pending') DEFAULT 'Pending',
  `cycle2Mark` int DEFAULT NULL,
  `observationOMarks` int DEFAULT '0',
  `observationXMarks` int DEFAULT '0',
  `observationTotalMarks` int DEFAULT '0',
  `pfyTotalMarks` int DEFAULT '0',
  `grandTotalMarks` int DEFAULT '0',
  `percentage` decimal(6,2) DEFAULT '0.00',
  `passingCriteria` decimal(5,2) DEFAULT '70.00',
  `finalResult` enum('Pass','Fail','Pending') DEFAULT 'Pending',
  `evaluationStatus` enum('Draft','Submitted','Reviewed') DEFAULT 'Draft',
  `remarks` text,
  `createdBy` int DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`practicalEvalID`),
  KEY `idx_pe_user` (`uniqueID`),
  KEY `idx_pe_subcourse` (`subCourseID`),
  KEY `idx_pe_user_subcourse` (`uniqueID`,`subCourseID`),
  KEY `idx_pe_testdate` (`testDate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `practical_evaluation_observations` (
  `observationID` bigint NOT NULL AUTO_INCREMENT,
  `practicalEvalID` bigint NOT NULL,
  `uniqueID` int NOT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `checkpointNo` int NOT NULL,
  `checkForText` text,
  `checkInText` text,
  `dayNo` int NOT NULL,
  `observationValue` enum('O','X') DEFAULT NULL,
  `obtainedMark` tinyint NOT NULL DEFAULT '0',
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`observationID`),
  UNIQUE KEY `uk_eval_checkpoint_day` (`practicalEvalID`,`checkpointNo`,`dayNo`),
  KEY `idx_peo_eval` (`practicalEvalID`),
  KEY `idx_peo_user` (`uniqueID`),
  KEY `idx_peo_subcourse` (`subCourseID`),
  CONSTRAINT `fk_peo_eval` FOREIGN KEY (`practicalEvalID`) REFERENCES `practical_evaluations` (`practicalEvalID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `practical_evaluation_actionplans` (
  `actionPlanID` bigint NOT NULL AUTO_INCREMENT,
  `practicalEvalID` bigint DEFAULT NULL,
  `uniqueID` int DEFAULT NULL,
  `deptID` int DEFAULT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `issueText` text,
  `actionText` text,
  `targetDate` date DEFAULT NULL,
  `status` enum('Open','Closed','Pending') DEFAULT 'Open',
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`actionPlanID`),
  KEY `idx_action_eval` (`practicalEvalID`),
  CONSTRAINT `fk_action_eval` FOREIGN KEY (`practicalEvalID`) REFERENCES `practical_evaluations` (`practicalEvalID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `ojt_feedbacks` (
  `uniqueID` int NOT NULL,
  `deptID` int NOT NULL,
  `areaID` int DEFAULT NULL,
  `mCourseID` int DEFAULT NULL,
  `coMCourseID` int DEFAULT NULL,
  `subCourseID` int DEFAULT NULL,
  `FeedBack` text,
  `Date` text NOT NULL,
  `trainerID` int DEFAULT NULL,
  KEY `idx_ojt_user_subcourse` (`uniqueID`,`subCourseID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `levels` (
  `id` int NOT NULL AUTO_INCREMENT,
  `levelName` varchar(100) DEFAULT NULL,
  `levelDescription` text,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Helpful My Courses query pattern:
-- SELECT DISTINCT sc.*
-- FROM enrollstatus es
-- JOIN subcourses sc
--   ON sc.deptID = es.deptID
--  AND (es.areaID IS NULL OR sc.areaID = es.areaID)
--  AND (es.mCourseID IS NULL OR sc.mCourseID = es.mCourseID)
--  AND (es.coMCourseID IS NULL OR sc.coMCourseID = es.coMCourseID)
--  AND (es.subCourseID IS NULL OR sc.subCourseID = es.subCourseID)
-- WHERE es.uniqueID = ?
--   AND COALESCE(es.enrollStatus, 'Active') IN ('Active','active','Enrolled','enrolled');
