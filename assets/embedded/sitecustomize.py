"""Start World Media when the isolated embedded Python runtime initializes."""

from worldmedia_native import main


# The signed pythonw.exe launcher has no script argument.  The embedded
# runtime imports ``sitecustomize`` after its restricted paths are configured,
# so this is the portable distribution's explicit application entry point.
main()
