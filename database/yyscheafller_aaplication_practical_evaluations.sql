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
-- Table structure for table `practical_evaluations`
--

DROP TABLE IF EXISTS `practical_evaluations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
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
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `practical_evaluations`
--

LOCK TABLES `practical_evaluations` WRITE;
/*!40000 ALTER TABLE `practical_evaluations` DISABLE KEYS */;
/*!40000 ALTER TABLE `practical_evaluations` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-07-02 12:35:33
