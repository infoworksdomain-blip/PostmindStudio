-- DropIndex
DROP INDEX "studio"."business_profiles_businessId_key";

-- DropIndex
DROP INDEX "studio"."image_library_businessId_fingerprint_key";

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_organisationId_businessId_key" ON "studio"."business_profiles"("organisationId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "image_library_organisationId_businessId_fingerprint_key" ON "studio"."image_library"("organisationId", "businessId", "fingerprint");

