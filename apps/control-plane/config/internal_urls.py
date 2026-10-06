"""URLconf for the internal runtime API process (AXP_URLCONF=config.internal_urls).

Kept separate from config.urls so the public server cannot route to it.
"""

from django.urls import path

from chat.control.internal_api import api

urlpatterns = [path("internal/", api.urls)]
