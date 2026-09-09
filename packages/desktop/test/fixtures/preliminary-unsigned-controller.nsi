Unicode true
RequestExecutionLevel user
SilentInstall silent

!ifndef FIXTURE_OUTFILE
  !error "FIXTURE_OUTFILE is required"
!endif
!ifndef FIXTURE_PAYLOAD
  !error "FIXTURE_PAYLOAD is required"
!endif

Name "BharatCode preliminary unsigned controller fixture"
OutFile "${FIXTURE_OUTFILE}"
InstallDir "$TEMP\bharatcode-preliminary-nsis-decoy"

Section
  SetOutPath "$INSTDIR"
  File "/oname=BharatCode Beta.exe" "${FIXTURE_PAYLOAD}"
  FileOpen $0 "$INSTDIR\fixture-install-root.txt" w
  FileWrite $0 "$INSTDIR"
  FileClose $0
SectionEnd
