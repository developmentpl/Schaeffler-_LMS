-- MySQL dump 10.13  Distrib 8.0.33, for Win64 (x86_64)
--
-- Host: 192.168.31.150    Database: yyscheafller_aaplication
-- ------------------------------------------------------
-- Server version	8.0.33

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `subcourses`
--

DROP TABLE IF EXISTS `subcourses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
  `stationID` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`subCourseID`),
  KEY `idx_subcourses_hierarchy` (`deptID`,`areaID`,`mCourseID`,`coMCourseID`),
  KEY `idx_subcourses_course_type` (`courseType`),
  KEY `fk_subcourses_area` (`areaID`),
  KEY `fk_subcourses_mcourse` (`mCourseID`),
  KEY `fk_subcourses_comain` (`coMCourseID`),
  CONSTRAINT `fk_subcourses_area` FOREIGN KEY (`areaID`) REFERENCES `areas` (`areaID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_comain` FOREIGN KEY (`coMCourseID`) REFERENCES `comaincourses` (`coMCourseID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_dept` FOREIGN KEY (`deptID`) REFERENCES `departments` (`deptID`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_subcourses_mcourse` FOREIGN KEY (`mCourseID`) REFERENCES `mcourses` (`mCourseID`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `subcourses`
--

LOCK TABLES `subcourses` WRITE;
/*!40000 ALTER TABLE `subcourses` DISABLE KEYS */;
INSERT INTO `subcourses` VALUES (1,1,1,1,1,'Training Course','Training Course','2026-06-27',NULL,NULL,'level1',NULL,'uploads/Training Material/1782560024729_training/1782560024729_1780920557634-6.Loose Fitment of Plugs While Pump Testing_WM.mp4',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'yes',NULL,NULL,NULL,NULL,NULL,'training','video',NULL,NULL,NULL,NULL,NULL,NULL,0),(2,NULL,NULL,NULL,NULL,'Training course 123','Training course 123','2026-06-29',NULL,NULL,'Level 1',NULL,'uploads/Training Material/1782711562084_training/1782711562084_1780920557634-6.Loose Fitment of Plugs While Pump Testing_WM.mp4',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'yes',NULL,NULL,NULL,NULL,NULL,'training','video',NULL,NULL,NULL,NULL,NULL,NULL,0),(3,NULL,NULL,NULL,NULL,'scorm Course','scorm  Course','2026-06-30',NULL,NULL,'Level 1',NULL,'uploads\\Scorm_1782799779457','2026-09-30',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'scorm','scorm_zip','uploads\\Scorm_1782799779457',NULL,NULL,NULL,NULL,NULL,0),(4,NULL,NULL,NULL,NULL,'Training Course practcal','Training Course practcal','2026-06-30',NULL,NULL,'Level 1',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,70,NULL,NULL,NULL,NULL,NULL,NULL,'practical',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0),(5,1,1,1,1,'Demo4','Demo4','2026-06-30',NULL,NULL,'Level 2',NULL,'uploads\\Scorm_1782817258079','2026-12-30',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'scorm','scorm_zip','uploads\\Scorm_1782817258079',1,NULL,NULL,NULL,1,0),(6,NULL,NULL,NULL,NULL,'Training Course comon for level2 ','Training Course comon for level2 ','2026-07-01',NULL,NULL,'Level 2',NULL,'uploads\\Scorm_1782910149733','2026-10-01',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'scorm','scorm_zip','uploads\\Scorm_1782910149733',1,NULL,NULL,NULL,1,0);
/*!40000 ALTER TABLE `subcourses` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:36
